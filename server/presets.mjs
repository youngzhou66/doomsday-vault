/**
 * 本地播放器预设。{file} 替换为电影绝对路径，{time} 替换为续播秒数；
 * 无续播位置时，含 {time} 的整段参数会被丢弃。
 */
export const PRESET_COMMANDS = {
  auto: '',
  mpv: 'mpv --force-window=immediate --fullscreen --start={time} {file}',
  vlc: 'vlc --fullscreen --start-time={time} {file}',
  potplayer: 'PotPlayerMini64 {file} /seek={time}',
  mpc: 'mpc-hc64 {file}',
  iina: 'iina --mpv-start={time} {file}',
  system: '',
};

export const PLAYER_PRESETS = {
  auto: { label: '自动（mpv / VLC / PotPlayer，找不到就用系统默认）', command: '' },
  mpv: { label: 'mpv', command: PRESET_COMMANDS.mpv },
  vlc: { label: 'VLC', command: PRESET_COMMANDS.vlc },
  potplayer: { label: 'PotPlayer', command: PRESET_COMMANDS.potplayer },
  mpc: { label: 'MPC-HC / MPC-BE', command: PRESET_COMMANDS.mpc },
  iina: { label: 'IINA (macOS)', command: PRESET_COMMANDS.iina },
  system: { label: '系统默认程序', command: '' },
};
