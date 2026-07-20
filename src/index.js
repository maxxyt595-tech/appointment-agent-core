import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezonePlugin from "dayjs/plugin/timezone.js";

import { businessConfig } from "./businessConfig.js";
import { checkAvailability, createCalendarEvent, deleteCalendarEvent, listCalendarEvents, updateCalendarEvent } from "./calendar.js";

dotenv.config();

dayjs.extend(utc);
dayjs.extend(timezonePlugin);

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CALENDAR_ID = process.env.CALENDAR_ID;
const TIMEZONE = process.env.TIMEZONE || businessConfig.timezone;

function getDayKey(date) {
  return date.format("dddd").toLowerCase();
}

function getBusinessHoursForDate(date) {
  const dayKey = getDayKey(date);
  return businessConfig.hours[dayKey];
}

function isInsideBusinessHours(start, end, timezone = TIMEZONE) {
  const dayHours = getBusinessHoursForDate(start);

  if (!dayHours) {
    return {
      valid: false,
      reason: "Business is closed on this day"
    };
  }

  const open = dayjs.tz(`${start.format("YYYY-MM-DD")}T${dayHours.open}`, timezone);
  const close = dayjs.tz(`${start.format("YYYY-MM-DD")}T${dayHours.close}`, timezone);

  if (start.isBefore(open) || end.isAfter(close)) {
    return {
      valid: false,
      reason: `Appointment must be between ${dayHours.open} and ${dayHours.close}`
    };
  }

  return {
    valid: true
  };
}

function normalizePhone(phoneNumber) {
  return String(phoneNumber || "").replace(/\D/g, "");
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function getEventSearchText(event) {
  return normalizeText(`${event.summary || ""} ${event.description || ""}`);
}

function isSameStartMinute(eventStart, requestedStart) {
  return Math.abs(eventStart.valueOf() - requestedStart.valueOf()) <= 60 * 1000;
}

function findServiceKeyFromEvent(event) {
  const eventText = getEventSearchText(event);

  for (const [serviceKey, serviceConfig] of Object.entries(businessConfig.services)) {
    if (
      eventText.includes(normalizeText(serviceKey)) ||
      eventText.includes(normalizeText(serviceConfig.name))
    ) {
      return serviceKey;
    }
  }

  return null;
}

function extractCustomerNameFromEvent(event) {
  const description = event.description || "";
  const match = description.match(/Customer name:\s*(.+)/i);

  if (match?.[1]) {
    return match[1].trim();
  }

  const summary = event.summary || "";
  const parts = summary.split(" - ");

  if (parts.length >= 2) {
    return parts.slice(1).join(" - ").trim();
  }

  return "";
}

function isValidDateOnly(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(date || ""));
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "appointment-agent-core",
    business: businessConfig.businessName
  });
});


app.post("/book-appointment-if-available", async (req, res) => {
  try {
    const {
      customer_name,
      phone_number,
      service,
      start_datetime,
      timezone,
      notes
    } = req.body;

    if (!customer_name || !phone_number || !service || !start_datetime) {
      return res.status(400).json({
        status: "error",
        message: "Missing required fields: customer_name, phone_number, service, start_datetime"
      });
    }

    const selectedService = businessConfig.services[service];

    if (!selectedService) {
      return res.status(400).json({
        status: "error",
        message: "Invalid service",
        allowed_services: Object.keys(businessConfig.services)
      });
    }

    const bookingTimezone = timezone || TIMEZONE;
    const start = dayjs(start_datetime).tz(bookingTimezone);
    const end = start.add(selectedService.durationMinutes, "minute");

    if (!start.isValid()) {
      return res.status(400).json({
        status: "error",
        message: "Invalid start_datetime"
      });
    }

    const now = dayjs().tz(bookingTimezone);

    if (start.isBefore(now)) {
      return res.status(400).json({
        status: "error",
        message: "Cannot book an appointment in the past"
      });
    }

    const hoursCheck = isInsideBusinessHours(start, end);

    if (!hoursCheck.valid) {
      return res.status(400).json({
        status: "unavailable",
        reason: hoursCheck.reason
      });
    }

    const availability = await checkAvailability({
      calendarId: CALENDAR_ID,
      startDateTime: start.toISOString(),
      endDateTime: end.toISOString(),
      timezone: bookingTimezone
    });

    if (!availability.available) {
      return res.json({
        status: "busy",
        message: "Requested time is already booked",
        requested_slot: {
          date: start.format("dddd, MMMM D, YYYY"),
          start_time: start.format("h:mm A"),
          end_time: end.format("h:mm A")
        },
        busy_slots: availability.busySlots
      });
    }

    const cleanPhone = normalizePhone(phone_number);

    const event = await createCalendarEvent({
      calendarId: CALENDAR_ID,
      title: `${selectedService.name} - ${customer_name}`,
      description: [
        `Customer name: ${customer_name}`,
        `Phone number: ${cleanPhone}`,
        `Service: ${selectedService.name}`,
        `Appointment source: AI phone agent`,
        `Notes: ${notes || ""}`
      ].join("\n"),
      startDateTime: start.toISOString(),
      endDateTime: end.toISOString(),
      timezone: bookingTimezone
    });

    return res.json({
      status: "booked",
      message: "Appointment confirmed",
      business: businessConfig.businessName,
      service: selectedService.name,
      customer_name,
      phone_number: cleanPhone,
      date: start.format("dddd, MMMM D, YYYY"),
      start_time: start.format("h:mm A"),
      end_time: end.format("h:mm A"),
      timezone: bookingTimezone,
      calendar_event_id: event.id,
      calendar_event_link: event.htmlLink
    });
  } catch (error) {
    console.error("Booking error:", error);

    return res.status(500).json({
      status: "error",
      message: "Could not finalize appointment",
      details: error.message
    });
  }
});


app.post("/check-available-slots", async (req, res) => {
  try {
    const { service, date, timezone } = req.body;

    if (!service || !date) {
      return res.status(400).json({
        status: "error",
        message: "Missing required fields: service, date"
      });
    }

    const selectedService = businessConfig.services[service];

    if (!selectedService) {
      return res.status(400).json({
        status: "error",
        message: "Invalid service",
        allowed_services: Object.keys(businessConfig.services)
      });
    }

    if (!isValidDateOnly(date)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid date. Use YYYY-MM-DD."
      });
    }

    const bookingTimezone = timezone || TIMEZONE;
    const selectedDate = dayjs.tz(`${date}T00:00:00`, bookingTimezone);

    if (!selectedDate.isValid()) {
      return res.status(400).json({
        status: "error",
        message: "Invalid date"
      });
    }

    const dayHours = getBusinessHoursForDate(selectedDate);

    if (!dayHours) {
      return res.json({
        status: "unavailable",
        message: "That date is outside business hours.",
        service,
        date: selectedDate.format("dddd, MMMM D, YYYY"),
        available_slots: []
      });
    }

    const open = dayjs.tz(`${date}T${dayHours.open}`, bookingTimezone);
    const close = dayjs.tz(`${date}T${dayHours.close}`, bookingTimezone);
    const now = dayjs().tz(bookingTimezone);

    const availableSlots = [];
    let cursor = open;

    while (cursor.add(selectedService.durationMinutes, "minute").isSame(close) || cursor.add(selectedService.durationMinutes, "minute").isBefore(close)) {
      const slotStart = cursor;
      const slotEnd = cursor.add(selectedService.durationMinutes, "minute");

      if (slotStart.isAfter(now)) {
        const availability = await checkAvailability({
          calendarId: CALENDAR_ID,
          startDateTime: slotStart.toISOString(),
          endDateTime: slotEnd.toISOString(),
          timezone: bookingTimezone
        });

        if (availability.available) {
          availableSlots.push({
            start_time: slotStart.format("h:mm A"),
            end_time: slotEnd.format("h:mm A"),
            start_datetime: slotStart.format()
          });
        }
      }

      cursor = cursor.add(60, "minute");
    }

    if (availableSlots.length === 0) {
      return res.json({
        status: "full",
        message: "No available slots found for that date.",
        service,
        date: selectedDate.format("dddd, MMMM D, YYYY"),
        available_slots: []
      });
    }

    const firstAvailableTimes = availableSlots.slice(0, 4).map((slot) => slot.start_time);
    const availableTimesText =
      firstAvailableTimes.length === 1
        ? firstAvailableTimes[0]
        : `${firstAvailableTimes.slice(0, -1).join(", ")}, and ${firstAvailableTimes.at(-1)}`;

    const spokenMessage = `For ${selectedService.name.toLowerCase()} on ${selectedDate.format("dddd, MMMM D")}, I have ${availableTimesText} available. Which one works best for you?`;

    return res.json({
      status: "available",
      message: spokenMessage,
      service,
      date: selectedDate.format("dddd, MMMM D, YYYY"),
      available_times_text: availableTimesText,
      available_slots: availableSlots
    });
  } catch (error) {
    console.error("Available slots error:", error);

    return res.status(500).json({
      status: "error",
      message: "Could not check available slots.",
      details: error.message
    });
  }
});


app.post("/cancel-appointment-if-found", async (req, res) => {
  try {
    const {
      customer_name,
      phone_number,
      service,
      start_datetime,
      current_start_datetime,
      appointment_start_datetime,
      timezone,
      notes
    } = req.body;

    const startInput =
      start_datetime || current_start_datetime || appointment_start_datetime;

    if (!phone_number || !startInput) {
      return res.status(400).json({
        status: "error",
        message: "Missing required fields: phone_number, start_datetime"
      });
    }

    const bookingTimezone = timezone || TIMEZONE;
    const requestedStart = dayjs(startInput).tz(bookingTimezone);

    if (!requestedStart.isValid()) {
      return res.status(400).json({
        status: "error",
        message: "Invalid start_datetime"
      });
    }

    const cleanPhone = normalizePhone(phone_number);

    if (!cleanPhone) {
      return res.status(400).json({
        status: "error",
        message: "Invalid phone_number"
      });
    }

    const searchStart = requestedStart.subtract(1, "minute");
    const searchEnd = requestedStart.add(1, "minute");

    const events = await listCalendarEvents({
      calendarId: CALENDAR_ID,
      timeMin: searchStart.toISOString(),
      timeMax: searchEnd.toISOString(),
      timezone: bookingTimezone
    });

    // Clean cancellation rule:
    // Primary match = phone number + exact appointment start time.
    // Name and service are optional because voice transcription can mishear them.
    const phoneAndTimeMatches = events.filter((event) => {
      const eventStartRaw = event.start?.dateTime;

      if (!eventStartRaw || event.status === "cancelled") {
        return false;
      }

      const eventStart = dayjs(eventStartRaw).tz(bookingTimezone);
      const eventPhoneDigits = normalizePhone(event.description || "");

      const phoneMatches = eventPhoneDigits.includes(cleanPhone);
      const timeMatches = isSameStartMinute(eventStart, requestedStart);

      return phoneMatches && timeMatches;
    });

    let matches = phoneAndTimeMatches;

    // If service is provided and valid, use it only to narrow multiple matches.
    // Do not require service for normal cancellation.
    if (service && businessConfig.services[service] && phoneAndTimeMatches.length > 1) {
      const cleanServiceName = normalizeText(businessConfig.services[service].name);

      const serviceMatches = phoneAndTimeMatches.filter((event) => {
        const eventText = getEventSearchText(event);
        return eventText.includes(cleanServiceName);
      });

      if (serviceMatches.length > 0) {
        matches = serviceMatches;
      }
    }

    if (matches.length === 0) {
      return res.json({
        status: "not_found",
        message: "No matching appointment found. Nothing was canceled.",
        phone_number: cleanPhone,
        date: requestedStart.format("dddd, MMMM D, YYYY"),
        start_time: requestedStart.format("h:mm A")
      });
    }

    if (matches.length > 1) {
      return res.json({
        status: "ambiguous",
        message: "More than one matching appointment was found. Nothing was canceled.",
        phone_number: cleanPhone,
        date: requestedStart.format("dddd, MMMM D, YYYY"),
        start_time: requestedStart.format("h:mm A")
      });
    }

    const eventToCancel = matches[0];

    await deleteCalendarEvent({
      calendarId: CALENDAR_ID,
      eventId: eventToCancel.id
    });

    const resolvedCustomerName =
      customer_name ||
      (typeof extractCustomerNameFromEvent === "function"
        ? extractCustomerNameFromEvent(eventToCancel)
        : "");

    return res.json({
      status: "canceled",
      message: "Appointment canceled",
      business: businessConfig.businessName,
      customer_name: resolvedCustomerName,
      phone_number: cleanPhone,
      date: requestedStart.format("dddd, MMMM D, YYYY"),
      start_time: requestedStart.format("h:mm A"),
      timezone: bookingTimezone,
      calendar_event_id: eventToCancel.id
    });
  } catch (error) {
    console.error("Cancellation error:", error);

    return res.status(500).json({
      status: "error",
      message: "Could not cancel appointment",
      details: error.message
    });
  }
});



app.post("/reschedule-appointment-if-found", async (req, res) => {
  try {
    const {
      customer_name,
      phone_number,
      service,
      current_start_datetime,
      old_start_datetime,
      original_start_datetime,
      new_start_datetime,
      timezone,
      notes
    } = req.body;

    const currentStartInput =
      current_start_datetime || old_start_datetime || original_start_datetime;

    if (!phone_number || !currentStartInput || !new_start_datetime) {
      return res.status(400).json({
        status: "error",
        message: "Missing required fields: phone_number, current_start_datetime, new_start_datetime"
      });
    }

    const bookingTimezone = timezone || TIMEZONE;
    const currentStart = dayjs(currentStartInput).tz(bookingTimezone);
    const newStart = dayjs(new_start_datetime).tz(bookingTimezone);

    if (!currentStart.isValid() || !newStart.isValid()) {
      return res.status(400).json({
        status: "error",
        message: "Invalid current_start_datetime or new_start_datetime"
      });
    }

    const now = dayjs().tz(bookingTimezone);

    if (newStart.isBefore(now)) {
      return res.json({
        status: "unavailable",
        message: "Cannot reschedule an appointment into the past"
      });
    }

    if (isSameStartMinute(currentStart, newStart)) {
      return res.json({
        status: "no_change",
        message: "The new appointment time is the same as the current appointment",
        date: currentStart.format("dddd, MMMM D, YYYY"),
        start_time: currentStart.format("h:mm A")
      });
    }

    const cleanPhone = normalizePhone(phone_number);

    const searchStart = currentStart.subtract(1, "minute");
    const searchEnd = currentStart.add(1, "minute");

    const currentSlotEvents = await listCalendarEvents({
      calendarId: CALENDAR_ID,
      timeMin: searchStart.toISOString(),
      timeMax: searchEnd.toISOString(),
      timezone: bookingTimezone
    });

    const matches = currentSlotEvents.filter((event) => {
      const eventStartRaw = event.start?.dateTime;

      if (!eventStartRaw || event.status === "cancelled") {
        return false;
      }

      const eventStart = dayjs(eventStartRaw).tz(bookingTimezone);
      const eventPhoneDigits = normalizePhone(event.description || "");

      return eventPhoneDigits.includes(cleanPhone) && isSameStartMinute(eventStart, currentStart);
    });

    if (matches.length === 0) {
      return res.json({
        status: "not_found",
        message: "No matching appointment found. Nothing was changed.",
        phone_number: cleanPhone,
        current_date: currentStart.format("dddd, MMMM D, YYYY"),
        current_start_time: currentStart.format("h:mm A")
      });
    }

    if (matches.length > 1) {
      return res.json({
        status: "ambiguous",
        message: "More than one matching appointment was found. Nothing was changed.",
        phone_number: cleanPhone,
        current_date: currentStart.format("dddd, MMMM D, YYYY"),
        current_start_time: currentStart.format("h:mm A")
      });
    }

    const eventToMove = matches[0];

    let serviceKey = null;

    if (service && businessConfig.services[service]) {
      serviceKey = service;
    } else {
      serviceKey = findServiceKeyFromEvent(eventToMove);
    }

    if (!serviceKey || !businessConfig.services[serviceKey]) {
      return res.json({
        status: "need_service",
        message: "I found the appointment, but I need the service to safely calculate the new appointment length.",
        phone_number: cleanPhone,
        current_date: currentStart.format("dddd, MMMM D, YYYY"),
        current_start_time: currentStart.format("h:mm A")
      });
    }

    const selectedService = businessConfig.services[serviceKey];
    const newEnd = newStart.add(selectedService.durationMinutes, "minute");

    const hoursCheck = isInsideBusinessHours(newStart, newEnd);

    if (!hoursCheck.valid) {
      return res.json({
        status: "unavailable",
        message: hoursCheck.reason,
        requested_new_slot: {
          date: newStart.format("dddd, MMMM D, YYYY"),
          start_time: newStart.format("h:mm A"),
          end_time: newEnd.format("h:mm A")
        }
      });
    }

    const newSlotEvents = await listCalendarEvents({
      calendarId: CALENDAR_ID,
      timeMin: newStart.toISOString(),
      timeMax: newEnd.toISOString(),
      timezone: bookingTimezone
    });

    const conflicts = newSlotEvents.filter((event) => {
      return event.status !== "cancelled" && event.id !== eventToMove.id;
    });

    if (conflicts.length > 0) {
      return res.json({
        status: "busy",
        message: "Requested new time is already booked. Existing appointment was not changed.",
        requested_new_slot: {
          date: newStart.format("dddd, MMMM D, YYYY"),
          start_time: newStart.format("h:mm A"),
          end_time: newEnd.format("h:mm A")
        },
        current_slot_kept: {
          date: currentStart.format("dddd, MMMM D, YYYY"),
          start_time: currentStart.format("h:mm A")
        }
      });
    }

    const existingDescription = eventToMove.description || "";
    const rescheduleNote = [
      "",
      "Rescheduled by AI phone agent",
      `Previous appointment time: ${currentStart.format("dddd, MMMM D, YYYY")} at ${currentStart.format("h:mm A")}`,
      `New appointment time: ${newStart.format("dddd, MMMM D, YYYY")} at ${newStart.format("h:mm A")}`,
      `Notes: ${notes || ""}`
    ].join("\n");

    const updatedEvent = await updateCalendarEvent({
      calendarId: CALENDAR_ID,
      eventId: eventToMove.id,
      title: eventToMove.summary,
      description: existingDescription + rescheduleNote,
      startDateTime: newStart.toISOString(),
      endDateTime: newEnd.toISOString(),
      timezone: bookingTimezone
    });

    return res.json({
      status: "rescheduled",
      message: "Appointment rescheduled",
      business: businessConfig.businessName,
      service: selectedService.name,
      customer_name: customer_name || extractCustomerNameFromEvent(eventToMove),
      phone_number: cleanPhone,
      old_date: currentStart.format("dddd, MMMM D, YYYY"),
      old_start_time: currentStart.format("h:mm A"),
      new_date: newStart.format("dddd, MMMM D, YYYY"),
      new_start_time: newStart.format("h:mm A"),
      new_end_time: newEnd.format("h:mm A"),
      timezone: bookingTimezone,
      calendar_event_id: updatedEvent.id,
      calendar_event_link: updatedEvent.htmlLink
    });
  } catch (error) {
    console.error("Reschedule error:", error);

    return res.status(500).json({
      status: "error",
      message: "Could not reschedule appointment",
      details: error.message
    });
  }
});



app.get("/warm", (req, res) => {
  res.json({
    status: "ok",
    service: "appointment-agent-core",
    warmed: true,
    timestamp: new Date().toISOString()
  });
});



app.get("/legal/privacy-policy", (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy - Ram's Auto Detailing</title>
</head>
<body>
  <h1>Privacy Policy</h1>

  <p>Ram's Auto Detailing uses customer information only to schedule, reschedule, cancel, and confirm appointments.</p>

  <h2>Information We Collect</h2>
  <p>We may collect a customer's name, mobile phone number, appointment date and time, selected service, and appointment notes.</p>

  <h2>SMS Messages</h2>
  <p>Customers may receive appointment confirmations, appointment reminders, appointment reschedule confirmations, appointment cancellation confirmations, and appointment-related updates after providing consent to receive SMS messages.</p>

  <p>Message frequency varies based on appointment activity. Message and data rates may apply. Reply STOP to opt out. Reply HELP for assistance.</p>

  <h2>Mobile Number Sharing</h2>
  <p>No mobile information will be shared with third parties or affiliates for marketing or promotional purposes. Text messaging originator opt-in data and consent will not be shared with any third parties. This information is used only to provide appointment-related SMS communications.</p>

  <h2>Opt Out</h2>
  <p>Customers may opt out of SMS messages at any time by replying STOP.</p>

  <h2>Help</h2>
  <p>Customers may reply HELP for assistance or contact Ram's Auto Detailing.</p>

  <h2>Contact</h2>
  <p>For questions, contact Ram's Auto Detailing.</p>
</body>
</html>`);
});

app.get("/legal/terms-and-conditions", (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terms and Conditions - Ram's Auto Detailing</title>
</head>
<body>
  <h1>Terms and Conditions</h1>

  <p>By providing your mobile phone number and verbally agreeing to receive SMS messages during your phone call with Ram's Auto Detailing, you consent to receive appointment-related SMS messages.</p>

  <p>SMS consent is optional and is not required to book, reschedule, cancel, or purchase appointment services.</p>

  <h2>SMS Program Description</h2>
  <p>Messages may include appointment confirmations, appointment reminders, appointment reschedule confirmations, appointment cancellation confirmations, and appointment-related updates.</p>

  <h2>Message Frequency</h2>
  <p>Message frequency varies based on appointment activity.</p>

  <h2>Fees</h2>
  <p>Message and data rates may apply.</p>

  <h2>Opt Out</h2>
  <p>You may cancel SMS messages at any time by replying STOP.</p>

  <h2>Help</h2>
  <p>For assistance, reply HELP or contact Ram's Auto Detailing.</p>

  <h2>Privacy</h2>
  <p>Mobile information will not be shared with third parties or affiliates for marketing or promotional purposes. Text messaging originator opt-in data and consent will not be shared with any third parties.</p>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Appointment Agent Core running on http://localhost:${PORT}`);
});
