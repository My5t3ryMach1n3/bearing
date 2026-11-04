workspace "Booking" "The approved target for Chairside's booking API, cut down to two requirements." {
  model {
    patient = person "Patient" "Someone booking an appointment at a Chairside clinic" {
      properties {
        "bearing.requirements" "#1,#5"
      }
    }

    chairside = softwareSystem "Chairside" "Books dental appointments and reminds patients of them" {
      properties {
        "bearing.requirements" "#1,#5"
      }

      bookingApi = container "Booking API" "Books appointments in open slots" "Python, FastAPI" {
        properties {
          "bearing.requirements" "#1,#5"
        }

        bookingRoutes = component "Booking routes" {
          description "The HTTP API"
          properties {
            "bearing.path" "app/routes"
            "bearing.requirements" "#1,#5"
          }
        }
        bookingService = component "Booking service" {
          description "Applies booking rules"
          properties {
            "bearing.path" "app/booking"
            "bearing.requirements" "#1,#5"
          }
        }
        availabilityService = component "Availability service" {
          description "Knows which slots are free, and is the only code that reserves one"
          properties {
            "bearing.path" "app/availability"
            "bearing.requirements" "#1,#5"
          }
        }
        appointmentRepository = component "Appointment repository" {
          description "Stores slots and appointments"
          properties {
            "bearing.path" "app/repository"
            "bearing.requirements" "#1,#5"
          }
        }
      }
    }

    patient -> bookingRoutes "Books appointments using" "JSON/HTTPS" {
      properties {
        "bearing.requirements" "#1,#5"
      }
    }
    bookingRoutes -> availabilityService "Lists free slots using" {
      properties {
        "bearing.requirements" "#1"
      }
    }
    bookingRoutes -> bookingService "Books appointments using" {
      properties {
        "bearing.requirements" "#1,#5"
      }
    }
    bookingService -> availabilityService "Reserves slots using" {
      properties {
        "bearing.requirements" "#1,#5"
      }
    }
    bookingService -> appointmentRepository "Reads appointments from" {
      properties {
        "bearing.requirements" "#1,#5"
      }
    }
    availabilityService -> appointmentRepository "Reads slots and inserts appointments in" {
      properties {
        "bearing.requirements" "#1,#5"
      }
    }
  }

  views {
    systemContext chairside "context" {
      include *
      autoLayout
    }
    container chairside "containers" {
      include *
      autoLayout
    }
    component bookingApi "components" {
      include *
      autoLayout
    }

    dynamic bookingApi "req-1" "#1 Book an open slot" {
      patient -> bookingRoutes "GET /slots"
      bookingRoutes -> availabilityService "free_slots()"
      availabilityService -> appointmentRepository "booked_slot_ids(), slots()"
      patient -> bookingRoutes "POST /appointments"
      bookingRoutes -> bookingService "book()"
      bookingService -> availabilityService "reserve()"
      availabilityService -> appointmentRepository "insert()"
      autoLayout
      properties {
        "bearing.criteria" "AC1:9d94f6eb,AC2:8a7de3a4"
      }
    }

    dynamic bookingApi "req-5" "#5 Never book one slot twice" {
      patient -> bookingRoutes "POST /appointments"
      bookingRoutes -> bookingService "book()"
      bookingService -> availabilityService "reserve()"
      availabilityService -> appointmentRepository "insert(), refused if the slot is taken"
      autoLayout
      properties {
        "bearing.criteria" "AC1:43ac8101,AC2:cce2f028"
      }
    }
  }
}
