// A curated set of common IANA timezones for the per-provider 时区 picker. Not exhaustive — just the
// regions users realistically route through. Empty value ('') means "跟随系统" (no TZ injection).
export interface TimezoneOption { value: string; label: string }

export const TIMEZONE_OPTIONS: TimezoneOption[] = [
  { value: '', label: '跟随系统（默认）' },
  { value: 'Asia/Shanghai', label: '中国 · 上海 (UTC+8)' },
  { value: 'Asia/Hong_Kong', label: '中国香港 (UTC+8)' },
  { value: 'Asia/Taipei', label: '中国台北 (UTC+8)' },
  { value: 'Asia/Singapore', label: '新加坡 (UTC+8)' },
  { value: 'Asia/Tokyo', label: '日本 · 东京 (UTC+9)' },
  { value: 'Asia/Seoul', label: '韩国 · 首尔 (UTC+9)' },
  { value: 'Asia/Kolkata', label: '印度 (UTC+5:30)' },
  { value: 'Asia/Dubai', label: '阿联酋 · 迪拜 (UTC+4)' },
  { value: 'Europe/London', label: '英国 · 伦敦 (UTC+0/+1)' },
  { value: 'Europe/Paris', label: '欧洲中部 · 巴黎 (UTC+1/+2)' },
  { value: 'Europe/Berlin', label: '德国 · 柏林 (UTC+1/+2)' },
  { value: 'Europe/Moscow', label: '俄罗斯 · 莫斯科 (UTC+3)' },
  { value: 'America/New_York', label: '美东 · 纽约 (UTC-5/-4)' },
  { value: 'America/Chicago', label: '美中 · 芝加哥 (UTC-6/-5)' },
  { value: 'America/Denver', label: '美山地 · 丹佛 (UTC-7/-6)' },
  { value: 'America/Los_Angeles', label: '美西 · 洛杉矶 (UTC-8/-7)' },
  { value: 'America/Sao_Paulo', label: '巴西 · 圣保罗 (UTC-3)' },
  { value: 'Australia/Sydney', label: '澳洲 · 悉尼 (UTC+10/+11)' },
  { value: 'UTC', label: 'UTC (UTC+0)' },
]
