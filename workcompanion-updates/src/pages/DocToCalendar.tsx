import { useState, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  CalendarPlus,
  Upload,
  FileText,
  Trash2,
  Download,
  Edit3,
  Check,
  X,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  Clock,
  MapPin,
  Repeat,
  Bell,
  Eye,
  Zap,
  FileDown,
  CalendarRange,
  Info,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { generateId } from '@/lib/utils'
import { extractDatesFromText, extractTextFromFile } from '@/lib/dateExtractor'
import { generateIcsFile, downloadIcsFile } from '@/lib/icsGenerator'
import { APP_NAME } from '@/lib/constants'
import type { IcsEvent } from '@/types/ics'
import { REMINDER_OPTIONS } from '@/types/ics'

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.08 },
  },
}

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
}

type Step = 'upload' | 'review' | 'details'

export default function DocToCalendar() {
  const [step, setStep] = useState<Step>('upload')
  const [isDragging, setIsDragging] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [rawText, setRawText] = useState('')
  const [events, setEvents] = useState<IcsEvent[]>([])
  const [selectedEvents, setSelectedEvents] = useState<Set<string>>(new Set())
  const [editingEvent, setEditingEvent] = useState<string | null>(null)
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null)
  const [showRawText, setShowRawText] = useState(false)
  const [manualText, setManualText] = useState('')
  const [showManualInput, setShowManualInput] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    setError(null)
    const file = files[0]
    if (!file) return

    setIsProcessing(true)
    setFileName(file.name)

    try {
      const text = await extractTextFromFile(file)
      if (!text.trim()) {
        setError('Could not extract any text from this document. Try a different file format.')
        setIsProcessing(false)
        return
      }
      setRawText(text)
      const extracted = extractDatesFromText(text)

      if (extracted.length === 0) {
        setError('No dates found in this document. You can manually enter text with dates below, or try a different document.')
        setShowManualInput(true)
        setIsProcessing(false)
        return
      }

      setEvents(extracted)
      setSelectedEvents(new Set(extracted.map(e => e.id)))
      setStep('review')
    } catch (err: any) {
      setError(err.message || 'Failed to process document')
    } finally {
      setIsProcessing(false)
    }
  }, [])

  const handleManualParse = useCallback(() => {
    if (!manualText.trim()) return
    setError(null)
    const extracted = extractDatesFromText(manualText)
    if (extracted.length === 0) {
      setError('No dates found in the provided text. Make sure dates are in common formats (e.g., Jan 15, 2025 or 01/15/2025).')
      return
    }
    setRawText(manualText)
    setEvents(extracted)
    setSelectedEvents(new Set(extracted.map(e => e.id)))
    setFileName('Manual Input')
    setStep('review')
  }, [manualText])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    handleFiles(e.dataTransfer.files)
  }, [handleFiles])

  const toggleSelect = (id: string) => {
    setSelectedEvents(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAll = () => setSelectedEvents(new Set(events.map(e => e.id)))
  const selectNone = () => setSelectedEvents(new Set())

  const updateEvent = (id: string, updates: Partial<IcsEvent>) => {
    setEvents(prev => prev.map(e => e.id === id ? { ...e, ...updates } : e))
  }

  const removeEvent = (id: string) => {
    setEvents(prev => prev.filter(e => e.id !== id))
    setSelectedEvents(prev => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  const addBlankEvent = () => {
    const today = new Date()
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const newEvent: IcsEvent = {
      id: generateId(),
      title: 'New Event',
      description: '',
      location: '',
      startDate: dateStr,
      startTime: '',
      endDate: dateStr,
      endTime: '',
      allDay: true,
      reminder: 15,
      recurrence: null,
      confidence: 100,
      sourceText: 'Manually added',
    }
    setEvents(prev => [...prev, newEvent])
    setSelectedEvents(prev => new Set([...prev, newEvent.id]))
    setEditingEvent(newEvent.id)
  }

  const downloadSelected = () => {
    const selected = events.filter(e => selectedEvents.has(e.id))
    if (selected.length === 0) return
    const content = generateIcsFile(selected)
    const safeName = fileName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]/g, '_') || 'events'
    downloadIcsFile(content, `larre-${safeName}.ics`)
  }

  const downloadSingle = (event: IcsEvent) => {
    const content = generateIcsFile([event])
    const safeName = event.title.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30) || 'event'
    downloadIcsFile(content, `larre-${safeName}.ics`)
  }

  const resetAll = () => {
    setStep('upload')
    setEvents([])
    setSelectedEvents(new Set())
    setFileName('')
    setRawText('')
    setError(null)
    setEditingEvent(null)
    setExpandedEvent(null)
    setShowRawText(false)
    setManualText('')
    setShowManualInput(false)
  }

  const confidenceColor = (c: number) => {
    if (c >= 85) return 'text-green-500'
    if (c >= 60) return 'text-amber-500'
    return 'text-red-400'
  }

  const confidenceLabel = (c: number) => {
    if (c >= 85) return 'High'
    if (c >= 60) return 'Medium'
    return 'Low'
  }

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="p-4 md:p-6 max-w-4xl mx-auto space-y-6 pb-24"
    >
      {/* Page Header */}
      <motion.div variants={itemVariants} className="space-y-1">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-amber-500 flex items-center justify-center">
            <CalendarPlus className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Doc to Calendar</h2>
            <p className="text-sm text-muted-foreground">
              Extract dates from documents and generate calendar files
            </p>
          </div>
        </div>
      </motion.div>

      {/* Step indicator */}
      <motion.div variants={itemVariants} className="flex items-center gap-2 text-sm">
        <StepBadge label="Upload" step="upload" current={step} />
        <ChevronDown className="w-4 h-4 text-muted-foreground rotate-[-90deg]" />
        <StepBadge label="Review" step="review" current={step} />
        <ChevronDown className="w-4 h-4 text-muted-foreground rotate-[-90deg]" />
        <StepBadge label="Download" step="details" current={step} />
      </motion.div>

      {/* Error display */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="flex items-start gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400"
          >
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm">{error}</p>
            </div>
            <button onClick={() => setError(null)} className="p-1 hover:bg-red-500/20 rounded">
              <X className="w-4 h-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* STEP 1: Upload */}
      {step === 'upload' && (
        <motion.div variants={itemVariants} className="space-y-4">
          {/* Drop zone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              'border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-all duration-200',
              isDragging
                ? 'border-orange-500 bg-orange-500/10'
                : 'border-border hover:border-orange-500/50 hover:bg-muted/50'
            )}
          >
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept=".pdf,.txt,.csv,.html,.md,.rtf,.docx,.xlsx"
              onChange={(e) => e.target.files && handleFiles(e.target.files)}
            />
            {isProcessing ? (
              <div className="space-y-3">
                <div className="w-12 h-12 mx-auto rounded-full border-4 border-orange-500 border-t-transparent animate-spin" />
                <p className="text-muted-foreground">Extracting dates from {fileName}...</p>
              </div>
            ) : (
              <div className="space-y-3">
                <Upload className={cn('w-12 h-12 mx-auto', isDragging ? 'text-orange-500' : 'text-muted-foreground')} />
                <div>
                  <p className="font-medium">Drop a document here or click to browse</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    PDF, TXT, CSV, DOCX, XLSX, HTML, Markdown
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Or manual text input */}
          <div className="text-center">
            <button
              onClick={() => setShowManualInput(!showManualInput)}
              className="text-sm text-orange-500 hover:text-orange-400 transition-colors"
            >
              {showManualInput ? 'Hide' : 'Or paste text manually'}
            </button>
          </div>

          <AnimatePresence>
            {showManualInput && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="space-y-3"
              >
                <textarea
                  value={manualText}
                  onChange={(e) => setManualText(e.target.value)}
                  placeholder="Paste text containing dates here...&#10;&#10;Example:&#10;Monthly team meeting - January 15, 2025 at 2:00 PM&#10;Project deadline - February 28, 2025&#10;Quarterly review - March 31, 2025 at 10:00 AM"
                  className={cn(
                    'w-full h-48 p-4 rounded-xl text-sm resize-none',
                    'bg-muted border border-border',
                    'focus:outline-none focus:ring-2 focus:ring-ring',
                    'placeholder:text-muted-foreground'
                  )}
                />
                <button
                  onClick={handleManualParse}
                  disabled={!manualText.trim()}
                  className={cn(
                    'w-full py-2.5 rounded-xl font-medium text-sm transition-all',
                    manualText.trim()
                      ? 'bg-gradient-to-r from-orange-500 to-amber-500 text-white hover:opacity-90'
                      : 'bg-muted text-muted-foreground cursor-not-allowed'
                  )}
                >
                  <div className="flex items-center justify-center gap-2">
                    <Zap className="w-4 h-4" />
                    Extract Dates
                  </div>
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Supported formats info */}
          <div className="flex items-start gap-2 p-3 rounded-xl bg-muted/50 text-xs text-muted-foreground">
            <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-foreground/70">Supported date formats</p>
              <p className="mt-1">
                January 15, 2025 &bull; 01/15/2025 &bull; 2025-01-15 &bull; 15th Jan 2025 &bull;
                Times: 2:30 PM, 14:30 &bull; Recurring: weekly, monthly, etc.
              </p>
            </div>
          </div>
        </motion.div>
      )}

      {/* STEP 2: Review Events */}
      {(step === 'review' || step === 'details') && (
        <motion.div variants={itemVariants} className="space-y-4">
          {/* Source info & controls */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm">
              <FileText className="w-4 h-4 text-orange-500" />
              <span className="font-medium">{fileName}</span>
              <span className="text-muted-foreground">
                &bull; {events.length} event{events.length !== 1 ? 's' : ''} found
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowRawText(!showRawText)}
                className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-muted hover:bg-muted/80 transition-colors"
              >
                <Eye className="w-3.5 h-3.5" />
                {showRawText ? 'Hide' : 'View'} Source
              </button>
              <button
                onClick={resetAll}
                className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-muted hover:bg-muted/80 transition-colors text-red-400"
              >
                <X className="w-3.5 h-3.5" />
                Start Over
              </button>
            </div>
          </div>

          {/* Raw text preview */}
          <AnimatePresence>
            {showRawText && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
              >
                <pre className="p-4 rounded-xl bg-muted text-xs overflow-auto max-h-48 whitespace-pre-wrap border border-border">
                  {rawText.substring(0, 5000)}
                  {rawText.length > 5000 && '\n\n... (truncated)'}
                </pre>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Selection controls */}
          <div className="flex items-center gap-3">
            <button onClick={selectAll} className="text-xs text-orange-500 hover:text-orange-400">Select All</button>
            <button onClick={selectNone} className="text-xs text-muted-foreground hover:text-foreground">Deselect All</button>
            <div className="flex-1" />
            <button
              onClick={addBlankEvent}
              className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-orange-500/10 text-orange-500 hover:bg-orange-500/20 transition-colors"
            >
              <CalendarPlus className="w-3.5 h-3.5" />
              Add Event
            </button>
            <span className="text-xs text-muted-foreground">
              {selectedEvents.size} selected
            </span>
          </div>

          {/* Event list */}
          <div className="space-y-2">
            {events.map((event) => (
              <EventCard
                key={event.id}
                event={event}
                selected={selectedEvents.has(event.id)}
                editing={editingEvent === event.id}
                expanded={expandedEvent === event.id}
                onToggleSelect={() => toggleSelect(event.id)}
                onToggleExpand={() => setExpandedEvent(expandedEvent === event.id ? null : event.id)}
                onEdit={() => setEditingEvent(editingEvent === event.id ? null : event.id)}
                onUpdate={(updates) => updateEvent(event.id, updates)}
                onRemove={() => removeEvent(event.id)}
                onDownload={() => downloadSingle(event)}
                confidenceColor={confidenceColor}
                confidenceLabel={confidenceLabel}
              />
            ))}
          </div>

          {events.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <CalendarRange className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p>No events. Add one manually or upload a different document.</p>
            </div>
          )}

          {/* Download section */}
          {events.length > 0 && (
            <motion.div
              variants={itemVariants}
              className="p-4 rounded-xl bg-gradient-to-r from-orange-500/10 to-amber-500/10 border border-orange-500/20 space-y-3"
            >
              <div className="flex items-center gap-2">
                <FileDown className="w-5 h-5 text-orange-500" />
                <span className="font-medium">Export Calendar Events</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={downloadSelected}
                  disabled={selectedEvents.size === 0}
                  className={cn(
                    'flex items-center gap-2 px-4 py-2.5 rounded-xl font-medium text-sm transition-all',
                    selectedEvents.size > 0
                      ? 'bg-gradient-to-r from-orange-500 to-amber-500 text-white hover:opacity-90'
                      : 'bg-muted text-muted-foreground cursor-not-allowed'
                  )}
                >
                  <Download className="w-4 h-4" />
                  Download {selectedEvents.size} Event{selectedEvents.size !== 1 ? 's' : ''} (.ics)
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                Combined .ics file compatible with Google Calendar, Apple Calendar, Outlook, and more.
                Each event includes a "{APP_NAME}" watermark.
              </p>
            </motion.div>
          )}
        </motion.div>
      )}

      {/* LARRE watermark */}
      <motion.div
        variants={itemVariants}
        className="text-center text-xs text-muted-foreground/50 pt-4"
      >
        Powered by {APP_NAME} &bull; Doc to Calendar
      </motion.div>
    </motion.div>
  )
}

// ---- Sub-components ----

function StepBadge({ label, step, current }: { label: string; step: Step; current: Step }) {
  const steps: Step[] = ['upload', 'review', 'details']
  const stepIdx = steps.indexOf(step)
  const currentIdx = steps.indexOf(current)
  const isActive = step === current
  const isDone = stepIdx < currentIdx

  return (
    <span
      className={cn(
        'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
        isActive && 'bg-orange-500/20 text-orange-500',
        isDone && 'bg-green-500/20 text-green-500',
        !isActive && !isDone && 'bg-muted text-muted-foreground'
      )}
    >
      {isDone ? <Check className="w-3 h-3 inline mr-1" /> : null}
      {label}
    </span>
  )
}

interface EventCardProps {
  event: IcsEvent
  selected: boolean
  editing: boolean
  expanded: boolean
  onToggleSelect: () => void
  onToggleExpand: () => void
  onEdit: () => void
  onUpdate: (updates: Partial<IcsEvent>) => void
  onRemove: () => void
  onDownload: () => void
  confidenceColor: (c: number) => string
  confidenceLabel: (c: number) => string
}

function EventCard({
  event, selected, editing, expanded,
  onToggleSelect, onToggleExpand, onEdit, onUpdate, onRemove, onDownload,
  confidenceColor, confidenceLabel,
}: EventCardProps) {
  const formatDisplayDate = (d: string) => {
    const [y, m, day] = d.split('-').map(Number)
    const date = new Date(y, m - 1, day)
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
  }

  return (
    <motion.div
      layout
      className={cn(
        'rounded-xl border transition-all duration-200',
        selected
          ? 'border-orange-500/40 bg-orange-500/5'
          : 'border-border bg-card'
      )}
    >
      {/* Main row */}
      <div className="flex items-center gap-3 p-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          className="w-4 h-4 rounded accent-orange-500 cursor-pointer flex-shrink-0"
        />
        <button onClick={onToggleExpand} className="flex-1 text-left min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate">{event.title}</span>
            <span className={cn('text-xs', confidenceColor(event.confidence))}>
              {confidenceLabel(event.confidence)}
            </span>
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatDisplayDate(event.startDate)}
              {event.startTime && ` at ${event.startTime}`}
              {event.allDay && ' (All Day)'}
            </span>
            {event.recurrence && (
              <span className="flex items-center gap-1 text-orange-500">
                <Repeat className="w-3 h-3" />
                {event.recurrence.freq.toLowerCase()}
              </span>
            )}
            {event.location && (
              <span className="flex items-center gap-1">
                <MapPin className="w-3 h-3" />
                {event.location}
              </span>
            )}
          </div>
        </button>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button onClick={onEdit} className="p-1.5 rounded-lg hover:bg-muted transition-colors" title="Edit">
            <Edit3 className="w-4 h-4 text-muted-foreground" />
          </button>
          <button onClick={onDownload} className="p-1.5 rounded-lg hover:bg-muted transition-colors" title="Download">
            <Download className="w-4 h-4 text-muted-foreground" />
          </button>
          <button onClick={onRemove} className="p-1.5 rounded-lg hover:bg-red-500/10 transition-colors" title="Remove">
            <Trash2 className="w-4 h-4 text-red-400" />
          </button>
          <button onClick={onToggleExpand} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Expanded details / edit form */}
      <AnimatePresence>
        {(expanded || editing) && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 space-y-3 border-t border-border pt-3">
              {editing ? (
                <EventEditForm event={event} onUpdate={onUpdate} onDone={onEdit} />
              ) : (
                <div className="space-y-2 text-sm">
                  {event.description && (
                    <p className="text-muted-foreground">{event.description}</p>
                  )}
                  {event.sourceText && (
                    <div className="p-2 rounded-lg bg-muted/50 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground/70">Source: </span>
                      {event.sourceText}
                    </div>
                  )}
                  {event.reminder > 0 && (
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Bell className="w-3 h-3" />
                      Reminder: {REMINDER_OPTIONS.find(r => r.value === event.reminder)?.label || `${event.reminder} min`}
                    </p>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

interface EventEditFormProps {
  event: IcsEvent
  onUpdate: (updates: Partial<IcsEvent>) => void
  onDone: () => void
}

function EventEditForm({ event, onUpdate, onDone }: EventEditFormProps) {
  const inputClass = cn(
    'w-full px-3 py-2 rounded-lg text-sm',
    'bg-muted border border-border',
    'focus:outline-none focus:ring-2 focus:ring-ring',
    'placeholder:text-muted-foreground'
  )

  return (
    <div className="space-y-3">
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">Title</label>
        <input
          type="text"
          value={event.title}
          onChange={(e) => onUpdate({ title: e.target.value })}
          className={inputClass}
          placeholder="Event title"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Start Date</label>
          <input
            type="date"
            value={event.startDate}
            onChange={(e) => onUpdate({ startDate: e.target.value, endDate: e.target.value })}
            className={inputClass}
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Start Time</label>
          <input
            type="time"
            value={event.startTime}
            onChange={(e) => onUpdate({
              startTime: e.target.value,
              allDay: !e.target.value,
              endTime: e.target.value ? event.endTime || '' : '',
            })}
            className={inputClass}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">End Date</label>
          <input
            type="date"
            value={event.endDate}
            onChange={(e) => onUpdate({ endDate: e.target.value })}
            className={inputClass}
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">End Time</label>
          <input
            type="time"
            value={event.endTime}
            onChange={(e) => onUpdate({ endTime: e.target.value })}
            className={inputClass}
          />
        </div>
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">Location</label>
        <input
          type="text"
          value={event.location}
          onChange={(e) => onUpdate({ location: e.target.value })}
          className={inputClass}
          placeholder="Add location (optional)"
        />
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">Description</label>
        <textarea
          value={event.description}
          onChange={(e) => onUpdate({ description: e.target.value })}
          className={cn(inputClass, 'h-20 resize-none')}
          placeholder="Add description (optional)"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Reminder</label>
          <select
            value={event.reminder}
            onChange={(e) => onUpdate({ reminder: Number(e.target.value) })}
            className={inputClass}
          >
            {REMINDER_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Recurrence</label>
          <select
            value={event.recurrence?.freq || 'none'}
            onChange={(e) => {
              const val = e.target.value
              if (val === 'none') {
                onUpdate({ recurrence: null })
              } else {
                onUpdate({
                  recurrence: {
                    freq: val as any,
                    interval: 1,
                  }
                })
              }
            }}
            className={inputClass}
          >
            <option value="none">None</option>
            <option value="DAILY">Daily</option>
            <option value="WEEKLY">Weekly</option>
            <option value="MONTHLY">Monthly</option>
            <option value="YEARLY">Yearly</option>
          </select>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={event.allDay}
            onChange={(e) => onUpdate({
              allDay: e.target.checked,
              startTime: e.target.checked ? '' : event.startTime,
              endTime: e.target.checked ? '' : event.endTime,
            })}
            className="w-4 h-4 rounded accent-orange-500"
          />
          All-day event
        </label>
      </div>

      <button
        onClick={onDone}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-orange-500/20 text-orange-500 hover:bg-orange-500/30 transition-colors text-sm font-medium"
      >
        <Check className="w-4 h-4" />
        Done Editing
      </button>
    </div>
  )
}
