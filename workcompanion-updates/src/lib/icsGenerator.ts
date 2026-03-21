import type { IcsEvent } from '@/types/ics'
import { APP_NAME, APP_FULL_NAME } from '@/lib/constants'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function toIcsDatetime(dateStr: string, timeStr: string): string {
  // dateStr: "YYYY-MM-DD", timeStr: "HH:mm"
  const [y, m, d] = dateStr.split('-').map(Number)
  const [h, min] = timeStr.split(':').map(Number)
  return `${y}${pad(m)}${pad(d)}T${pad(h)}${pad(min)}00`
}

function toIcsDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return `${y}${pad(m)}${pad(d)}`
}

function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
}

function foldLine(line: string): string {
  // ICS lines must be <= 75 octets; fold with CRLF + space
  const maxLen = 75
  if (line.length <= maxLen) return line
  const parts: string[] = []
  parts.push(line.substring(0, maxLen))
  let i = maxLen
  while (i < line.length) {
    parts.push(' ' + line.substring(i, i + maxLen - 1))
    i += maxLen - 1
  }
  return parts.join('\r\n')
}

function generateUID(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let uid = ''
  for (let i = 0; i < 32; i++) {
    uid += chars[Math.floor(Math.random() * chars.length)]
  }
  return `${uid}@larre-app`
}

function buildRecurrenceRule(event: IcsEvent): string | null {
  if (!event.recurrence) return null
  const { freq, interval, count, until } = event.recurrence
  let rule = `RRULE:FREQ=${freq}`
  if (interval > 1) rule += `;INTERVAL=${interval}`
  if (count) rule += `;COUNT=${count}`
  if (until) rule += `;UNTIL=${toIcsDate(until)}`
  return rule
}

function buildVEvent(event: IcsEvent): string {
  const lines: string[] = []
  const now = new Date()
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`

  lines.push('BEGIN:VEVENT')
  lines.push(`UID:${generateUID()}`)
  lines.push(`DTSTAMP:${stamp}`)

  if (event.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${toIcsDate(event.startDate)}`)
    // For all-day events, end date is exclusive (next day)
    const endParts = event.endDate.split('-').map(Number)
    const endD = new Date(endParts[0], endParts[1] - 1, endParts[2] + 1)
    lines.push(`DTEND;VALUE=DATE:${endD.getFullYear()}${pad(endD.getMonth() + 1)}${pad(endD.getDate())}`)
  } else {
    lines.push(`DTSTART:${toIcsDatetime(event.startDate, event.startTime)}`)
    lines.push(`DTEND:${toIcsDatetime(event.endDate || event.startDate, event.endTime || event.startTime)}`)
  }

  lines.push(`SUMMARY:${escapeIcsText(event.title)}`)

  // Build description with LARRE watermark
  const descParts: string[] = []
  if (event.description) descParts.push(event.description)
  descParts.push('')
  descParts.push(`--- Created by ${APP_NAME} ---`)
  descParts.push(APP_FULL_NAME)
  lines.push(`DESCRIPTION:${escapeIcsText(descParts.join('\n'))}`)

  if (event.location) {
    lines.push(`LOCATION:${escapeIcsText(event.location)}`)
  }

  // Reminder / alarm
  if (event.reminder > 0) {
    const h = Math.floor(event.reminder / 60)
    const m = event.reminder % 60
    lines.push('BEGIN:VALARM')
    lines.push('ACTION:DISPLAY')
    lines.push(`DESCRIPTION:Reminder: ${escapeIcsText(event.title)}`)
    lines.push(`TRIGGER:-PT${h > 0 ? h + 'H' : ''}${m > 0 ? m + 'M' : ''}`)
    lines.push('END:VALARM')
  }

  // Recurrence
  const rrule = buildRecurrenceRule(event)
  if (rrule) lines.push(rrule)

  lines.push('END:VEVENT')
  return lines.map(foldLine).join('\r\n')
}

export function generateIcsFile(events: IcsEvent[]): string {
  const lines: string[] = []
  lines.push('BEGIN:VCALENDAR')
  lines.push('VERSION:2.0')
  lines.push(`PRODID:-//${APP_NAME}//Doc to Calendar//EN`)
  lines.push('CALSCALE:GREGORIAN')
  lines.push('METHOD:PUBLISH')
  lines.push(`X-WR-CALNAME:${APP_NAME} Events`)

  for (const event of events) {
    lines.push(buildVEvent(event))
  }

  lines.push('END:VCALENDAR')
  return lines.join('\r\n')
}

export function downloadIcsFile(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.ics') ? filename : `${filename}.ics`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function downloadAllAsZip(events: IcsEvent[]) {
  // For simplicity, generate a single combined ICS file with all events
  const content = generateIcsFile(events)
  downloadIcsFile(content, 'larre-events-combined.ics')
}
