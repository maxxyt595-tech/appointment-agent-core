export const businessConfig = {
  businessId: "rams_auto_detailing",
  businessName: "Ram’s Auto Detailing",
  timezone: "America/New_York",

  hours: {
    monday: { open: "09:00", close: "18:00" },
    tuesday: { open: "09:00", close: "18:00" },
    wednesday: { open: "09:00", close: "18:00" },
    thursday: { open: "09:00", close: "18:00" },
    friday: { open: "09:00", close: "18:00" },
    saturday: { open: "09:00", close: "18:00" },
    sunday: null
  },

  services: {
    basic_wash: {
      name: "Basic wash",
      durationMinutes: 45
    },
    interior_detail: {
      name: "Interior detail",
      durationMinutes: 90
    },
    full_detail: {
      name: "Full detail",
      durationMinutes: 120
    },
    ceramic_consultation: {
      name: "Ceramic consultation",
      durationMinutes: 30
    }
  }
};
