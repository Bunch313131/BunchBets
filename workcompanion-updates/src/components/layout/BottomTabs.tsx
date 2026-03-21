import { NavLink } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  LayoutDashboard,
  CheckSquare,
  Share2,
  FolderOpen,
  StickyNote,
  CalendarPlus,
  Settings,
  Sun,
  Moon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useThemeStore } from '@/stores/themeStore'

const tabs = [
  { to: '/', icon: LayoutDashboard, label: 'Home' },
  { to: '/tasks', icon: CheckSquare, label: 'Tasks' },
  { to: '/share', icon: Share2, label: 'Share' },
  { to: '/files', icon: FolderOpen, label: 'Files' },
  { to: '/notes', icon: StickyNote, label: 'Notes' },
  { to: '/calendar', icon: CalendarPlus, label: 'Cal' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]

export function BottomTabs() {
  const { isDark, toggleTheme } = useThemeStore()

  return (
    <nav
      className={cn(
        'md:hidden fixed bottom-0 left-0 right-0 z-50',
        'bg-background/80 backdrop-blur-xl border-t border-border',
        'safe-area-bottom'
      )}
    >
      <div className="flex items-center justify-around h-16 px-1">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.to === '/'}
            className={({ isActive }) =>
              cn(
                'flex flex-col items-center justify-center gap-0.5 px-2 py-1.5 rounded-xl',
                'transition-all duration-200 relative min-w-[44px]',
                isActive
                  ? 'text-primary'
                  : 'text-muted-foreground'
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <motion.div
                    layoutId="bottom-tab-active"
                    className="absolute inset-0 bg-primary/10 rounded-xl"
                    transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                  />
                )}
                <tab.icon className="w-5 h-5 relative z-10" />
                <span className="text-[10px] font-medium relative z-10">
                  {tab.label}
                </span>
              </>
            )}
          </NavLink>
        ))}

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          className={cn(
            'flex flex-col items-center justify-center gap-0.5 px-2 py-1.5 rounded-xl',
            'transition-all duration-200 min-w-[44px]',
            'text-muted-foreground'
          )}
        >
          {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          <span className="text-[10px] font-medium">
            {isDark ? 'Light' : 'Dark'}
          </span>
        </button>
      </div>
      {/* Safe area spacer for iOS */}
      <div className="h-[env(safe-area-inset-bottom)]" />
    </nav>
  )
}
