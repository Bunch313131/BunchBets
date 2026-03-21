import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Search,
  X,
  Zap,
} from 'lucide-react'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { APP_NAME, APP_LOGO } from '@/lib/constants'
import { cn } from '@/lib/utils'

const PAGE_TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/tasks': 'Tasks',
  '/share': 'Quick Share',
  '/files': 'Files',
  '/notes': 'Notes',
  '/calendar': 'Doc to Calendar',
  '/settings': 'Settings',
}

export function Header() {
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const isMobile = useIsMobile()
  const location = useLocation()

  const pageTitle = PAGE_TITLES[location.pathname] || ''

  return (
    <header
      className={cn(
        'sticky top-0 z-30 h-16 flex items-center justify-between px-4 md:px-6',
        'bg-background/80 backdrop-blur-xl border-b border-border',
        'transition-colors duration-300'
      )}
    >
      {/* Left: Title / Logo on mobile */}
      <div className="flex items-center gap-2 min-w-0 flex-shrink">
        {isMobile && (
          APP_LOGO ? (
            <img src={APP_LOGO} alt={APP_NAME} className="w-24 h-auto flex-shrink-0" />
          ) : (
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-orange-500 to-amber-500 flex items-center justify-center flex-shrink-0">
              <Zap className="w-4 h-4 text-white" />
            </div>
          )
        )}
        <h1 className="text-lg font-semibold truncate">
          {pageTitle}
        </h1>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-1 flex-shrink-0">
        {/* Search */}
        <AnimatePresence>
          {searchOpen ? (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: isMobile ? '100%' : 300, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="relative"
            >
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search everything..."
                autoFocus
                className={cn(
                  'w-full h-9 pl-10 pr-9 rounded-lg text-sm',
                  'bg-muted border border-border',
                  'focus:outline-none focus:ring-2 focus:ring-ring',
                  'placeholder:text-muted-foreground'
                )}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setSearchOpen(false)
                    setSearchQuery('')
                  }
                }}
              />
              <button
                onClick={() => {
                  setSearchOpen(false)
                  setSearchQuery('')
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-accent"
              >
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            </motion.div>
          ) : (
            <motion.button
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              onClick={() => setSearchOpen(true)}
              className={cn(
                'p-2 rounded-lg hover:bg-accent transition-colors',
                'text-muted-foreground hover:text-foreground'
              )}
            >
              <Search className="w-5 h-5" />
            </motion.button>
          )}
        </AnimatePresence>

      </div>
    </header>
  )
}
