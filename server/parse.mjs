/**
 * 文件名解析：标题、年份、分辨率、来源、编码、音轨、剪辑版本、是否剧集。
 * 纯函数，无 IO，方便单测。
 */

const RESOLUTION_RULES = [
  [/(?:^|\W)(?:4320p|8k)(?:\W|$)/i, '4320p'],
  [/(?:^|\W)(?:2160p|4k|uhd)(?:\W|$)/i, '2160p'],
  [/(?:^|\W)(?:1440p)(?:\W|$)/i, '1440p'],
  [/(?:^|\W)(?:1080p|fhd)(?:\W|$)/i, '1080p'],
  [/(?:^|\W)(?:720p)(?:\W|$)/i, '720p'],
  [/(?:^|\W)(?:576p|540p|480p|360p|sd)(?:\W|$)/i, '480p'],
];

const SOURCE_RULES = [
  [/remux/i, 'REMUX'],
  [/blu-?ray|bdrip|brrip|bdremux|bd25|bd50/i, 'BluRay'],
  [/web-?dl|webdl|web-?rip|web/i, 'WEB-DL'],
  [/hdtv|pdtv|dsr/i, 'HDTV'],
  [/dvd-?rip|dvd-?r|dvd5|dvd9|dvd/i, 'DVD'],
  [/hdcam|cam-?rip|\bcam\b|telesync/i, 'CAM'],
];

const VIDEO_CODEC_RULES = [
  [/x265|h\.?265|hevc/i, 'HEVC'],
  [/x264|h\.?264|\bavc\b/i, 'H.264'],
  [/\bav1\b/i, 'AV1'],
  [/xvid/i, 'XviD'],
  [/divx/i, 'DivX'],
  [/vp9/i, 'VP9'],
  [/mpeg-?2|\bmpg2\b/i, 'MPEG-2'],
  [/vc-?1/i, 'VC-1'],
];

const AUDIO_RULES = [
  [/dts-?hd|dts-?x/i, 'DTS-HD'],
  [/dts/i, 'DTS'],
  [/truehd/i, 'TrueHD'],
  [/atmos/i, 'Atmos'],
  [/ddp|eac3|dd\+/i, 'E-AC3'],
  [/\bdd\b|ac-?3|ac3/i, 'AC3'],
  [/flac/i, 'FLAC'],
  [/\baac\b/i, 'AAC'],
  [/opus/i, 'Opus'],
  [/mp3/i, 'MP3'],
];

const EDITION_RULES = [
  [/director'?s?[ .-]?cut/i, "Director's Cut"],
  [/extended[ .-]?(?:cut|edition)?/i, 'Extended'],
  [/unrated/i, 'Unrated'],
  [/theatrical/i, 'Theatrical'],
  [/final[ .-]cut/i, 'Final Cut'],
  [/imax/i, 'IMAX'],
  [/remaster(?:ed)?/i, 'Remastered'],
  [/criterion/i, 'Criterion'],
  [/special[ .-]edition/i, 'Special Edition'],
  [/open[ .-]matte/i, 'Open Matte'],
  [/uncut/i, 'Uncut'],
];

const RE_EPISODE = /(?:^|[\s._-])s(\d{1,2})[ ._-]?e(\d{1,3})(?:\W|$)/i;
const RE_EPISODE_ALT = /(?:^|[\s._-])(\d{1,2})x(\d{2,3})(?:\W|$)/i;
const RE_SEASON_ONLY = /(?:^|[\s._-])(?:season|s)[ ._-]?(\d{1,2})(?:\W|$)/i;
const RE_CN_EPISODE = /第\s*(\d{1,3})\s*[集话話]/;
const RE_PART = /(?:^|[\s._-])(?:cd|disc|disk|part|dvd)[ ._-]?(\d{1,2})(?:\W|$)/i;
const RE_GROUP_TAIL = /-([A-Za-z][A-Za-z0-9._-]{1,24})$/;
const RE_DOMAIN = /^(?:www\.[\w.-]+|[\w-]+\.(?:com|net|org|cn|cc|tv|me|io|xyz|top|vip|info))$/i;
const RE_BRACKET_LEAD = /^[[【(]\s*([^\]】)]*?)\s*[\]】)]$/;

/** 去掉扩展名。 */
function stripExt(fileName) {
  const idx = fileName.lastIndexOf('.');
  return idx > 0 ? fileName.slice(0, idx) : fileName;
}

/**
 * 判定 token 是否为发行年份。超出 [1888, 当前年+2] 的四位数字不算（例如 Blade Runner 2049）。
 * @returns {number|null}
 */
function yearOf(token) {
  const match = /^[[(（]?((?:18|19|20|21)\d{2})[\])）]?$/.exec(String(token));
  if (!match) return null;
  const year = Number(match[1]);
  const max = new Date().getFullYear() + 2;
  return year >= 1888 && year <= max ? year : null;
}

/** 文件名 -> token 数组。括号内的内容整段保留（"[YTS.MX]" 不能被点号拆散）。 */
function tokenize(base) {
  const segments = String(base).split(/([[【(][^\]】)]*[\]】)])/);
  const text = segments
    .map((segment, index) => (index % 2 === 1
      ? segment
      // 紧贴字符之间的点视为分隔符（The.Godfather.1972），保留 "Mr. Nobody" 这类缩写
      : segment.replace(/_/g, ' ').replace(/(?<=\S)\.(?=\S)/g, ' ')))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  let tokens = text.split(' ').filter(Boolean);

  // 去掉开头的中括号发布组 / 站点标记，如 [YTS.MX]、【高清】
  while (tokens.length) {
    const match = RE_BRACKET_LEAD.exec(tokens[0]);
    if (!match) break;
    // "(500) Days of Summer" 这类以数字括号开头的片名要保留
    if (/^\d{1,4}$/.test(match[1].trim())) break;
    tokens = tokens.slice(1);
  }
  // 去掉开头的网址/片源站点标记
  while (tokens.length && RE_DOMAIN.test(tokens[0])) tokens = tokens.slice(1);
  return tokens;
}

function firstMatch(rules, text) {
  for (const [re, label] of rules) if (re.test(text)) return label;
  return null;
}

function isNoiseToken(token) {
  return (
    RESOLUTION_RULES.some(([re]) => re.test(token)) ||
    SOURCE_RULES.some(([re]) => re.test(token)) ||
    VIDEO_CODEC_RULES.some(([re]) => re.test(token)) ||
    /^(?:x|h)\.?26[45]$/i.test(token) ||
    /^\d{3,4}[pi]$/i.test(token)
  );
}

function cleanTitle(tokens) {
  return tokens
    .join(' ')
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:;,._]+/, '')
    .replace(/[\s\-–—:;,._]+$/, '')
    .trim();
}

/**
 * @param {string} fileName 含扩展名的文件名
 * @returns {{
 *   title: string, year: number|null, resolution: string|null, source: string|null,
 *   videoCodec: string|null, audioCodec: string|null, edition: string|null, group: string|null,
 *   kind: 'movie'|'episode', season: number|null, episode: number|null, part: number|null,
 *   base: string
 * }}
 */
export function parseFileName(fileName) {
  const base = stripExt(String(fileName ?? ''));
  const tokens = tokenize(base);
  // 画质/编码等标记在原文本上匹配：保留 "H.264"、"DD5.1" 这类写法
  const scanText = base.replace(/_/g, ' ');

  const groupMatch = scanText.match(RE_GROUP_TAIL);
  const group = groupMatch ? groupMatch[1] : null;

  // 取"最后一个合法的年份 token"，且它前面必须有标题内容
  let yearIdx = -1;
  let year = null;
  tokens.forEach((token, index) => {
    const value = yearOf(token);
    if (value !== null && index > 0) {
      yearIdx = index;
      year = value;
    }
  });

  // 无年份时，标题截止到第一个画质/来源/编码标记
  let titleEnd = yearIdx >= 0 ? yearIdx : tokens.length;
  if (yearIdx < 0) {
    const markerIdx = tokens.findIndex(isNoiseToken);
    if (markerIdx > 0) titleEnd = markerIdx;
  }

  let title = cleanTitle(tokens.slice(0, titleEnd));
  // 标题为空（例如文件名只剩画质标记）时退化为整段文本
  if (!title) title = cleanTitle(tokens) || String(base).trim();

  const seasonEpisode = scanText.match(RE_EPISODE) ?? scanText.match(RE_EPISODE_ALT);
  const cnEpisode = scanText.match(RE_CN_EPISODE);
  const seasonOnly = scanText.match(RE_SEASON_ONLY);
  const partMatch = scanText.match(RE_PART);

  return {
    title,
    year,
    resolution: firstMatch(RESOLUTION_RULES, scanText),
    source: firstMatch(SOURCE_RULES, scanText),
    videoCodec: firstMatch(VIDEO_CODEC_RULES, scanText),
    audioCodec: firstMatch(AUDIO_RULES, scanText),
    edition: firstMatch(EDITION_RULES, scanText),
    group,
    kind: seasonEpisode || cnEpisode || seasonOnly ? 'episode' : 'movie',
    season: seasonEpisode ? Number(seasonEpisode[1]) : seasonOnly ? Number(seasonOnly[1]) : null,
    episode: seasonEpisode ? Number(seasonEpisode[2]) : cnEpisode ? Number(cnEpisode[1]) : null,
    part: partMatch ? Number(partMatch[1]) : null,
    base,
  };
}

/** TMDB 搜索词：标题 + 年份。 */
export function buildSearchQuery(parsed) {
  const title = String(parsed?.title ?? '').trim();
  if (!title) return '';
  return parsed?.year ? `${title} ${parsed.year}` : title;
}

const JUNK_TITLES = new Set([
  'video', 'movie', 'film', 'main', 'index', 'title', 'trailer', 'sample',
  'feature', 'play', 'unknown', 'movie_name', '片名', '电影', '正片', '视频',
]);

/** 文件名里的"标题"是否是无意义的占位词（video.mkv / CD1.avi / 1.mkv 之类）。 */
export function isJunkTitle(title) {
  const text = String(title ?? '').trim().toLowerCase();
  if (!text || text.length < 2) return true;
  if (JUNK_TITLES.has(text)) return true;
  if (/^\d{1,3}$/.test(text)) return true;
  if (/^(?:cd|disc|disk|part|dvd)[\s._-]?\d{1,2}$/.test(text)) return true;
  if (/^[a-z]$/.test(text)) return true;
  return false;
}

/**
 * 在"一片一目录"的常见布局下综合文件名与目录名解析：
 * 目录名通常更干净（"教父 (1972)"），文件名常带画质信息但也可能是 movie.mkv。
 *
 * @param {{fileName: string, folderName?: string|null}} input
 */
export function parseMovieName({ fileName, folderName = null }) {
  const fromFile = parseFileName(fileName);
  if (!folderName) return fromFile;

  const fromFolder = parseFileName(folderName);
  if (isJunkTitle(fromFolder.title)) return { ...fromFile, titleSource: 'file' };

  const fileIsJunk = isJunkTitle(fromFile.title);
  const takeFolderTitle = fileIsJunk || (fromFile.year === null && fromFolder.year !== null);
  const title = takeFolderTitle ? fromFolder.title : fromFile.title;
  const year = fromFile.year ?? fromFolder.year ?? null;
  const merged = {
    ...fromFile,
    title,
    year,
    // 技术字段优先文件名（目录名一般不含），文件名缺省时用目录名兜底
    resolution: fromFile.resolution ?? fromFolder.resolution,
    source: fromFile.source ?? fromFolder.source,
    videoCodec: fromFile.videoCodec ?? fromFolder.videoCodec,
    audioCodec: fromFile.audioCodec ?? fromFolder.audioCodec,
    edition: fromFile.edition ?? fromFolder.edition,
    folderName,
    // 只有标题真的来自目录名时才算 folder；仅用目录年份补齐仍算文件名解析
    titleSource: fileIsJunk ? 'folder' : 'file',
  };
  return merged;
}
