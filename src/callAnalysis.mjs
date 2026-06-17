/**
 * Call Recording Analysis Module
 * - STT (Speech-to-Text) for m4a files using Whisper
 * - Call-email matching based on phone number, name, date
 * - Conversation threading
 */

import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// Default call recordings directory
const DEFAULT_RECORDINGS_DIR = '/Users/jmpark/Library/Mobile Documents/com~apple~CloudDocs/개인자료/통화내역 녹음파일';

/**
 * Parse call recording filename to extract metadata
 * Format: {name}_{phone}_{date}_{time}.m4a
 * Example: 한영진 형님_01071913707_20260615_153712.m4a
 */
export function parseCallFilename(filename) {
  const name = basename(filename, extname(filename));
  const parts = name.split('_');
  
  if (parts.length >= 3) {
    const callerName = parts[0];
    const phone = parts[1];
    const dateStr = parts[2];
    const timeStr = parts[3] || '000000';
    
    // Parse date: 20260615 -> 2026-06-15
    const year = dateStr.slice(0, 4);
    const month = dateStr.slice(4, 6);
    const day = dateStr.slice(6, 8);
    
    // Parse time: 153712 -> 15:37:12
    const hour = timeStr.slice(0, 2);
    const minute = timeStr.slice(2, 4);
    const second = timeStr.slice(4, 6);
    
    return {
      filename,
      callerName,
      phone: phone.replace(/[^0-9]/g, ''),
      date: `${year}-${month}-${day}`,
      time: `${hour}:${minute}:${second}`,
      datetime: `${year}-${month}-${day}T${hour}:${minute}:${second}`,
      isValid: true
    };
  }
  
  // Try to extract phone number pattern
  const phoneMatch = name.match(/(\d{10,11})/);
  const dateMatch = name.match(/(\d{8})/);
  
  return {
    filename,
    callerName: name.split('_')[0] || 'Unknown',
    phone: phoneMatch ? phoneMatch[1] : '',
    date: dateMatch ? `${dateMatch[1].slice(0,4)}-${dateMatch[1].slice(4,6)}-${dateMatch[1].slice(6,8)}` : '',
    time: '',
    datetime: '',
    isValid: false
  };
}

/**
 * Convert m4a to wav for Whisper processing
 */
async function convertM4aToWav(m4aPath) {
  const wavPath = m4aPath.replace(/\.m4a$/i, '.wav');
  
  try {
    await execAsync(`ffmpeg -i "${m4aPath}" -ar 16000 -ac 1 -f wav "${wavPath}" -y`, {
      timeout: 60000
    });
    return wavPath;
  } catch (error) {
    throw new Error(`Failed to convert m4a to wav: ${error.message}`);
  }
}

/**
 * Transcribe audio file using Whisper
 */
export async function transcribeAudio(audioPath, { model = 'base', language = 'ko' } = {}) {
  try {
    // Use faster-whisper via Python script
    const script = `
import sys
from faster_whisper import WhisperModel

model = WhisperModel("${model}", device="cpu", compute_type="int8")
segments, info = model.transcribe("${audioPath}", language="${language}", beam_size=5)

result = []
for segment in segments:
    result.append({
        "start": segment.start,
        "end": segment.end,
        "text": segment.text.strip()
    })

import json
print(json.dumps(result, ensure_ascii=False))
`;
    
    const { stdout, stderr } = await execAsync(`python3 -c '${script}'`, {
      timeout: 300000 // 5 minutes timeout for long recordings
    });
    
    if (stderr) {
      console.warn('Whisper warning:', stderr);
    }
    
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Transcription failed: ${error.message}`);
  }
}

/**
 * Extract key information from transcript
 */
export function extractCallInfo(transcript, callerInfo) {
  const fullText = transcript.map(s => s.text).join(' ');
  
  // Extract potential action items
  const actionPatterns = [
    /(?:부탁|요청|확인|검토|승인|발송|전달|공유|준비|진행|처리|마감|일정|미팅|회의)/g,
    /(?:deadline|due|asap|urgent|긴급|오늘|내일|이번\s*주|다음\s*주)/gi
  ];
  
  const actions = [];
  for (const pattern of actionPatterns) {
    const matches = fullText.match(pattern);
    if (matches) {
      actions.push(...matches);
    }
  }
  
  // Extract dates mentioned
  const datePattern = /(\d{4}[.-]\d{1,2}[.-]\d{1,2}|\d{1,2}\/\d{1,2}|오늘|내일|금일|이번\s*주|다음\s*주|월요일|화요일|수요일|목요일|금요일)/g;
  const dates = [...new Set(fullText.match(datePattern) || [])];
  
  // Extract email addresses mentioned
  const emailPattern = /[\w.-]+@[\w.-]+\.\w+/g;
  const emails = [...new Set(fullText.match(emailPattern) || [])];
  
  return {
    ...callerInfo,
    transcript,
    fullText,
    summary: fullText.slice(0, 500),
    actions: [...new Set(actions)],
    dates,
    emails,
    duration: transcript.length > 0 ? 
      Math.round(transcript[transcript.length - 1].end - transcript[0].start) : 0
  };
}

/**
 * Load all call recordings from directory
 */
export async function loadCallRecordings(dir = DEFAULT_RECORDINGS_DIR) {
  try {
    const files = await readdir(dir);
    const m4aFiles = files.filter(f => f.endsWith('.m4a'));
    
    const recordings = [];
    for (const file of m4aFiles) {
      const filePath = join(dir, file);
      const info = await stat(filePath);
      const parsed = parseCallFilename(file);
      
      recordings.push({
        ...parsed,
        path: filePath,
        size: info.size,
        modifiedAt: info.mtime.toISOString()
      });
    }
    
    return recordings.sort((a, b) => 
      new Date(b.datetime || b.modifiedAt) - new Date(a.datetime || a.modifiedAt)
    );
  } catch (error) {
    throw new Error(`Failed to load recordings: ${error.message}`);
  }
}

/**
 * Match call recording with emails
 */
export function matchCallWithEmails(callInfo, emails) {
  const matches = [];
  
  for (const email of emails) {
    let score = 0;
    const reasons = [];
    
    // Match by phone number (if email has phone in signature)
    if (callInfo.phone) {
      const emailText = `${email.subject || ''} ${email.body || ''} ${email.bodyPreview || ''}`;
      if (emailText.includes(callInfo.phone)) {
        score += 5;
        reasons.push('전화번호 일치');
      }
    }
    
    // Match by caller name
    if (callInfo.callerName && callInfo.callerName !== 'Unknown') {
      const emailFrom = (email.fromName || email.from || '').toLowerCase();
      const callerLower = callInfo.callerName.toLowerCase();
      
      if (emailFrom.includes(callerLower) || callerLower.includes(emailFrom.split(' ')[0])) {
        score += 4;
        reasons.push('발신자 이름 일치');
      }
    }
    
    // Match by date (call date within 1 day of email)
    if (callInfo.date && email.receivedAt) {
      const callDate = new Date(callInfo.date);
      const emailDate = new Date(email.receivedAt);
      const diffDays = Math.abs(callDate - emailDate) / (1000 * 60 * 60 * 24);
      
      if (diffDays <= 1) {
        score += 3;
        reasons.push('날짜 일치 (±1일)');
      } else if (diffDays <= 3) {
        score += 1;
        reasons.push('날짜 유사 (±3일)');
      }
    }
    
    // Match by email address in transcript
    if (callInfo.emails && callInfo.emails.length > 0) {
      const emailAddr = (email.from || '').toLowerCase();
      if (callInfo.emails.some(e => e.toLowerCase() === emailAddr)) {
        score += 5;
        reasons.push('이메일 주소 일치');
      }
    }
    
    if (score > 0) {
      matches.push({
        email,
        score,
        reasons
      });
    }
  }
  
  return matches.sort((a, b) => b.score - a.score);
}

/**
 * Create conversation thread from emails and calls
 */
export function createConversationThread(emails, calls) {
  const threads = new Map();
  
  // Group emails by conversation
  for (const email of emails) {
    const threadId = email.conversationId || email.subject?.replace(/^(Re:|FW:)\s*/i, '') || email.id;
    
    if (!threads.has(threadId)) {
      threads.set(threadId, {
        id: threadId,
        subject: email.subject,
        participants: new Set(),
        emails: [],
        calls: [],
        startDate: email.receivedAt,
        endDate: email.receivedAt
      });
    }
    
    const thread = threads.get(threadId);
    thread.emails.push(email);
    thread.participants.add(email.from);
    if (email.to) email.to.forEach(t => thread.participants.add(t));
    
    // Update date range
    if (email.receivedAt < thread.startDate) thread.startDate = email.receivedAt;
    if (email.receivedAt > thread.endDate) thread.endDate = email.receivedAt;
  }
  
  // Match calls to threads
  for (const call of calls) {
    let bestThread = null;
    let bestScore = 0;
    
    for (const [threadId, thread] of threads) {
      const matches = matchCallWithEmails(call, thread.emails);
      if (matches.length > 0 && matches[0].score > bestScore) {
        bestScore = matches[0].score;
        bestThread = threadId;
      }
    }
    
    if (bestThread && bestScore >= 3) {
      threads.get(bestThread).calls.push({
        ...call,
        matchScore: bestScore
      });
    }
  }
  
  // Convert to array and sort by date
  return Array.from(threads.values())
    .map(thread => ({
      ...thread,
      participants: Array.from(thread.participants),
      emailCount: thread.emails.length,
      callCount: thread.calls.length,
      hasCallMatch: thread.calls.length > 0
    }))
    .sort((a, b) => new Date(b.endDate) - new Date(a.endDate));
}

/**
 * Process a single call recording (transcribe + analyze)
 */
export async function processCallRecording(filePath, options = {}) {
  const { model = 'base', language = 'ko' } = options;
  
  // Parse filename
  const callerInfo = parseCallFilename(filePath);
  
  // Convert to wav if needed
  let audioPath = filePath;
  if (filePath.endsWith('.m4a')) {
    audioPath = await convertM4aToWav(filePath);
  }
  
  // Transcribe
  const transcript = await transcribeAudio(audioPath, { model, language });
  
  // Extract info
  const callInfo = extractCallInfo(transcript, callerInfo);
  
  // Clean up wav file if we created one
  if (audioPath !== filePath) {
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(audioPath);
    } catch {}
  }
  
  return callInfo;
}

/**
 * Batch process multiple call recordings
 */
export async function batchProcessRecordings(recordings, options = {}) {
  const { concurrency = 1, ...transcribeOptions } = options;
  const results = [];
  
  for (const recording of recordings) {
    try {
      const result = await processCallRecording(recording.path, transcribeOptions);
      results.push({ success: true, ...result });
    } catch (error) {
      results.push({ 
        success: false, 
        ...recording, 
        error: error.message 
      });
    }
  }
  
  return results;
}
