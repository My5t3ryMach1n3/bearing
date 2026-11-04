workspace "Reminders" "The approved target for Chairside's reminder worker, cut down to one requirement." {
  model {
    patient = person "Patient" "Someone with an appointment at a Chairside clinic" {
      properties {
        "bearing.requirements" "#3"
      }
    }

    twilio = softwareSystem "Twilio" "Sends SMS messages" {
      tags "External"
      properties {
        "bearing.requirements" "#3"
      }
    }

    chairside = softwareSystem "Chairside" "Books dental appointments and reminds patients of them" {
      properties {
        "bearing.requirements" "#3"
      }

      appointmentEvents = container "Appointment events" "Carries each appointment's changes to the reminder worker" "Amazon SQS" {
        tags "Queue"
        properties {
          "bearing.requirements" "#3"
        }
      }

      reminderWorker = container "Reminder worker" "Texts each patient a reminder the day before their appointment" "Go" {
        properties {
          "bearing.requirements" "#3"
        }

        eventConsumer = component "Event consumer" {
          description "Reads appointment events off the queue"
          properties {
            "bearing.path" "internal/consumer"
            "bearing.requirements" "#3"
          }
        }
        scheduler = component "Scheduler" {
          description "Holds each reminder until 24 hours before its appointment"
          properties {
            "bearing.path" "internal/schedule"
            "bearing.requirements" "#3"
          }
        }
        smsSender = component "SMS sender" {
          description "The only code that holds patient numbers in transit to Twilio"
          properties {
            "bearing.path" "internal/sms"
            "bearing.requirements" "#3"
          }
        }
        reminderStore = component "Reminder store" {
          description "Records which reminders have been sent"
          properties {
            "bearing.path" "internal/store"
            "bearing.requirements" "#3"
          }
        }
      }
    }

    appointmentEvents -> eventConsumer "Delivers appointment events to" "SQS" {
      properties {
        "bearing.requirements" "#3"
      }
    }
    eventConsumer -> scheduler "Schedules reminders using" {
      properties {
        "bearing.requirements" "#3"
      }
    }
    scheduler -> reminderStore "Checks and records sent reminders in" {
      properties {
        "bearing.requirements" "#3"
      }
    }
    scheduler -> smsSender "Sends reminders using" {
      properties {
        "bearing.requirements" "#3"
      }
    }
    smsSender -> twilio "Posts messages to" "JSON/HTTPS" {
      properties {
        "bearing.requirements" "#3"
      }
    }
    twilio -> patient "Texts" {
      properties {
        "bearing.requirements" "#3"
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
    component reminderWorker "components" {
      include *
      autoLayout
    }

    dynamic reminderWorker "req-3" "#3 Remind patients before their appointment" {
      appointmentEvents -> eventConsumer "appointment.confirmed"
      eventConsumer -> scheduler "Schedule()"
      scheduler -> reminderStore "WasSent()"
      scheduler -> smsSender "Send()"
      smsSender -> twilio "POST /Messages"
      scheduler -> reminderStore "MarkSent()"
      autoLayout
      properties {
        "bearing.criteria" "AC1:c0f37159,AC2:3c87cf0d,AC3:79a6895d"
      }
    }

    styles {
      element "External" {
        background #999999
      }
      element "Queue" {
        shape Pipe
      }
    }
  }
}
