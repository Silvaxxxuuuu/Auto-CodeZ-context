import type { AIAttachment } from '../types';

const SECRETISH = /(?:sk|rk|pk|ghp|github_pat|AIza)[-_A-Za-z0-9]{12,}|eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}/g;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const LOCAL_PATH = /\b[A-Za-z]:[\\/][^\s"'<>]+|(?:^|\s)\/(?:Users|home|private|mnt|etc)\/[^\s"'<>]+/gi;
const LONG_ID = /\b[A-Fa-f0-9]{24,}\b|\b[A-Za-z0-9_-]{32,}\b/g;
const URL = /https?:\/\/[^\s"'<>]+/gi;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

const STOPWORDS = new Set([
  'uma','um','de','da','do','das','dos','e','o','a','os','as','com','para','por','que','em','na','no',
  'the','a','an','of','to','and','in','on','for','with','this','that','image','imagem','anexada','visual',
  'texto','reconhecido','descrição','descricao','screen','screenshot','captura','tela',
]);

function sanitizedWords(value: string): string[] {
  const scrubbed = value
    .replace(SECRETISH, ' ')
    .replace(EMAIL, ' ')
    .replace(LOCAL_PATH, ' ')
    .replace(LONG_ID, ' ')
    .replace(URL, ' ')
    .replace(IPV4, ' ')
    .replace(/[^\p{L}\p{N}._+#-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const seen = new Set<string>();
  const words: string[] = [];
  for (const raw of scrubbed.split(' ')) {
    const word = raw.trim();
    if (word.length < 2 || word.length > 40) continue;
    const key = word.toLocaleLowerCase();
    if (STOPWORDS.has(key) || seen.has(key)) continue;
    if (/^\d{5,}$/.test(word)) continue;
    seen.add(key);
    words.push(word);
    if (words.length >= 36) break;
  }
  return words;
}

export function visualAttachmentCues(attachment: AIAttachment): string {
  const caption = attachment.contexts?.find((context) => context.kind === 'caption' && context.text.trim())?.text ?? '';
  const ocr = attachment.contexts?.find((context) => context.kind === 'ocr' && context.text.trim())?.text ?? '';
  const words = [
    ...sanitizedWords(caption).slice(0, 20),
    ...sanitizedWords(ocr).slice(0, 20),
  ];
  return [...new Set(words)].slice(0, 32).join(' ');
}

export function visualSearchQuery(userMessage: string, attachment: AIAttachment, bestGuess?: string): string {
  const userWords = sanitizedWords(userMessage).slice(0, 16);
  const guessWords = sanitizedWords(bestGuess ?? '').slice(0, 10);
  const cueWords = sanitizedWords(visualAttachmentCues(attachment)).slice(0, 28);
  return [...new Set([...guessWords, ...cueWords, ...userWords])].slice(0, 42).join(' ');
}
