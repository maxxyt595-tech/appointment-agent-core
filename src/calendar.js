import { google } from "googleapis";
import dotenv from "dotenv";

dotenv.config();

function getGoogleAuth() {
  const scopes = ["https://www.googleapis.com/auth/calendar"];

  // Render / production: use base64 environment variable
  if (process.env.GOOGLE_SERVICE_ACCOUNT_BASE64) {
    const credentialsJson = Buffer.from(
      process.env.GOOGLE_SERVICE_ACCOUNT_BASE64,
      "base64"
    ).toString("utf8");

    const credentials = JSON.parse(credentialsJson);

    return new google.auth.GoogleAuth({
      credentials,
      scopes
    });
  }

  // Local development: use google-service-account.json file
  return new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes
  });
}

const auth = getGoogleAuth();

const calendar = google.calendar({
  version: "v3",
  auth
});

export async function checkAvailability({ calendarId, startDateTime, endDateTime, timezone }) {
  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin: startDateTime,
      timeMax: endDateTime,
      timeZone: timezone,
      items: [{ id: calendarId }]
    }
  });

  const busySlots = response.data.calendars?.[calendarId]?.busy || [];

  return {
    available: busySlots.length === 0,
    busySlots
  };
}

export async function createCalendarEvent({
  calendarId,
  title,
  description,
  startDateTime,
  endDateTime,
  timezone
}) {
  const response = await calendar.events.insert({
    calendarId,
    requestBody: {
      summary: title,
      description,
      start: {
        dateTime: startDateTime,
        timeZone: timezone
      },
      end: {
        dateTime: endDateTime,
        timeZone: timezone
      }
    }
  });

  return response.data;
}


export async function listCalendarEvents({
  calendarId,
  timeMin,
  timeMax,
  timezone
}) {
  const response = await calendar.events.list({
    calendarId,
    timeMin,
    timeMax,
    timeZone: timezone,
    singleEvents: true,
    orderBy: "startTime"
  });

  return response.data.items || [];
}

export async function deleteCalendarEvent({
  calendarId,
  eventId
}) {
  await calendar.events.delete({
    calendarId,
    eventId
  });

  return {
    deleted: true,
    eventId
  };
}


export async function updateCalendarEvent({
  calendarId,
  eventId,
  title,
  description,
  startDateTime,
  endDateTime,
  timezone
}) {
  const requestBody = {
    start: {
      dateTime: startDateTime,
      timeZone: timezone
    },
    end: {
      dateTime: endDateTime,
      timeZone: timezone
    }
  };

  if (title !== undefined) {
    requestBody.summary = title;
  }

  if (description !== undefined) {
    requestBody.description = description;
  }

  const response = await calendar.events.patch({
    calendarId,
    eventId,
    requestBody
  });

  return response.data;
}
