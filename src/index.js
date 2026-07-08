import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezonePlugin from "dayjs/plugin/timezone.js";

import { businessConfig } from "./businessConfig.js";
import { checkAvailability, createCalendarEvent } from "./calendar.js";

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

    const hoursCheck = isInsideBusinessHours(start, end, bookingTimezone);

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

app.listen(PORT, () => {
  console.log(`Appointment Agent Core running on http://localhost:${PORT}`);
});
