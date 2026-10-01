/**
 * Windows integration built on the PowerShell host (no native modules).
 *
 * OWNER: system agent. Everything must degrade gracefully on non-Windows (return empty/false, never throw
 * synchronously), because development happens on Linux.
 */
import type { ActiveWindowInfo } from '@shared/state'
import type { PowerShellHost } from './powershell'

export interface WindowInfo {
  hwnd: number
  title: string
  processName: string
  pid: number
}

export interface InstalledApp {
  name: string
  /** AppUserModelId (UWP/Start apps) or exe path. */
  launch: string
}

export interface SystemInfo {
  os: string
  hostname: string
  user: string
  cpu: string
  memoryGb: number
  uptimeMinutes: number
  battery?: { percent: number; charging: boolean }
}

export interface WindowsSystem {
  getActiveWindow(): Promise<ActiveWindowInfo | null>
  listWindows(): Promise<WindowInfo[]>
  focusWindow(query: { hwnd?: number; titleContains?: string; processName?: string }): Promise<boolean>
  minimizeWindow(query: { hwnd?: number; titleContains?: string }): Promise<boolean>
  closeWindow(query: { hwnd?: number; titleContains?: string; processName?: string }): Promise<boolean>
  listInstalledApps(): Promise<InstalledApp[]>
  launchApp(nameOrPath: string, args?: string[]): Promise<string>
  getVolume(): Promise<{ percent: number; muted: boolean }>
  setVolume(percent: number): Promise<void>
  setMuted(muted: boolean): Promise<void>
  mediaKey(key: 'play-pause' | 'next' | 'previous' | 'stop'): Promise<void>
  getBrightness(): Promise<number | null>
  setBrightness(percent: number): Promise<void>
  typeText(text: string): Promise<void>
  pressKeys(combo: string): Promise<void>
  clickAt(x: number, y: number, button?: 'left' | 'right' | 'double'): Promise<void>
  lockWorkstation(): Promise<void>
  power(action: 'sleep' | 'hibernate' | 'shutdown' | 'restart'): Promise<void>
  isElevated(): Promise<boolean>
  getSystemInfo(): Promise<SystemInfo>
}

export function createWindowsSystem(_ps: PowerShellHost): WindowsSystem {
  throw new Error('not implemented: createWindowsSystem (src/main/system/windows.ts)')
}
