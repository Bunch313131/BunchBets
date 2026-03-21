export interface IcsEvent {
  id: string
  title: string
  description: string
  location: string
  startDate: string    // ISO date string
  startTime: string    // HH:mm format, empty = all-day
  endDate: string      // ISO date string
  endTime: string      // HH:mm format, empty = all-day
  allDay: boolean
  reminder: number     // minutes before, 0 = none
  recurrence: RecurrenceRule | null
  confidence: number   // 0-100, how confident the parser is
  sourceText: string   // the original text snippet that was parsed
}

export interface RecurrenceRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
  interval: number
  count?: number
  until?: string       // ISO date
}

export interface ParsedDocument {
  fileName: string
  fileType: string
  rawText: string
  events: IcsEvent[]
  parseDate: string
}

export type ReminderOption = {
  label: string
  value: number
}

export const REMINDER_OPTIONS: ReminderOption[] = [
  { label: 'None', value: 0 },
  { label: '5 minutes', value: 5 },
  { label: '15 minutes', value: 15 },
  { label: '30 minutes', value: 30 },
  { label: '1 hour', value: 60 },
  { label: '1 day', value: 1440 },
  { label: '1 week', value: 10080 },
]
