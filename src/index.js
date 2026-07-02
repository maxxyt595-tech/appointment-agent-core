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

function isInsideBusinessHours(start, end) {
  const dayKey = getDayKey(start);
  const dayHours = businessConfig.hours[dayKey];

  if (!dayHours) {
    return {
      valid: false,
      reason: "Business is closed on this day"
    };
  }

  const open = dayjs.tz(`${start.format("YYYY-MM-DD")}T${dayHours.open}`, TIMEZONE);
  const close = dayjs.tz(`${start.format("YYYY-MM-DD")}T${dayHours.close}`, TIMEZONE);

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

app.listen(PORT, () => {
  console.log(`Appointment Agent Core running on http://localhost:${PORT}`);
});
