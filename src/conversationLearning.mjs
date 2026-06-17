/**
 * Conversation Learning Module
 * - Match incoming emails with outgoing replies
 * - Learn from user feedback on conversation flow
 * - Thread-based conversation analysis
 */

/**
 * Group messages by conversation thread
 */
export function groupByConversation(messages) {
  const threads = new Map();
  
  for (const msg of messages) {
    // Use conversationId if available, otherwise normalize subject
    const threadId = msg.conversationId || normalizeSubject(msg.subject);
    
    if (!threads.has(threadId)) {
      threads.set(threadId, {
        id: threadId,
        subject: msg.subject,
        messages: [],
        incoming: [],
        outgoing: [],
        participants: new Set()
      });
    }
    
    const thread = threads.get(threadId);
    thread.messages.push(msg);
    thread.participants.add(msg.from);
    
    if (msg.to) {
      msg.to.forEach(t => thread.participants.add(t));
    }
    
    // Classify as incoming or outgoing based on folder
    if (msg.mailFolder === 'sentitems' || msg.mailFolder === 'sent') {
      thread.outgoing.push(msg);
    } else {
      thread.incoming.push(msg);
    }
  }
  
  // Sort messages within each thread by date
  for (const thread of threads.values()) {
    thread.messages.sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt));
    thread.incoming.sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt));
    thread.outgoing.sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt));
    thread.participants = Array.from(thread.participants);
    thread.messageCount = thread.messages.length;
    thread.hasReply = thread.outgoing.length > 0;
  }
  
  return Array.from(threads.values());
}

/**
 * Normalize subject line for grouping
 */
function normalizeSubject(subject = '') {
  return subject
    .replace(/^(Re:|FW:|Fwd:|답장:|전달:)\s*/gi, '')
    .trim()
    .toLowerCase();
}

/**
 * Match incoming email with best outgoing reply
 */
export function matchReplyPair(incoming, outgoing) {
  const pairs = [];
  
  for (const inc of incoming) {
    let bestMatch = null;
    let bestScore = 0;
    
    for (const out of outgoing) {
      let score = 0;
      
      // Same conversation thread
      if (inc.conversationId && inc.conversationId === out.conversationId) {
        score += 5;
      }
      
      // Subject match (after removing Re:/FW:)
      if (normalizeSubject(inc.subject) === normalizeSubject(out.subject)) {
        score += 3;
      }
      
      // Reply is after incoming
      if (new Date(out.receivedAt) > new Date(inc.receivedAt)) {
        score += 2;
        
        // Time proximity (within 24 hours is ideal)
        const hoursDiff = (new Date(out.receivedAt) - new Date(inc.receivedAt)) / (1000 * 60 * 60);
        if (hoursDiff <= 24) {
          score += 2;
        } else if (hoursDiff <= 72) {
          score += 1;
        }
      }
      
      // Recipient match (outgoing TO should include incoming FROM)
      if (out.to && inc.from) {
        const outTo = out.to.map(t => t.toLowerCase());
        const incFrom = (inc.from || '').toLowerCase();
        if (outTo.includes(incFrom)) {
          score += 3;
        }
      }
      
      if (score > bestScore) {
        bestScore = score;
        bestMatch = out;
      }
    }
    
    if (bestMatch && bestScore >= 5) {
      pairs.push({
        incoming: inc,
        outgoing: bestMatch,
        score: bestScore,
        responseTime: calculateResponseTime(inc.receivedAt, bestMatch.receivedAt)
      });
    }
  }
  
  return pairs;
}

/**
 * Calculate response time between emails
 */
function calculateResponseTime(incomingDate, outgoingDate) {
  const diff = new Date(outgoingDate) - new Date(incomingDate);
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}일 ${hours % 24}시간`;
  }
  return `${hours}시간 ${minutes}분`;
}

/**
 * Analyze conversation patterns
 */
export function analyzeConversationPatterns(threads) {
  const stats = {
    totalThreads: threads.length,
    withReply: 0,
    withoutReply: 0,
    avgResponseTime: 0,
    topContacts: new Map(),
    conversationTypes: {
      inquiry: 0,      // 문의
      followUp: 0,     // 후속
      task: 0,         // 작업
      information: 0,  // 정보 공유
      other: 0
    }
  };
  
  let totalResponseTime = 0;
  let responseCount = 0;
  
  for (const thread of threads) {
    if (thread.hasReply) {
      stats.withReply++;
      
      // Calculate average response time
      const pairs = matchReplyPair(thread.incoming, thread.outgoing);
      for (const pair of pairs) {
        const hours = (new Date(pair.outgoing.receivedAt) - new Date(pair.incoming.receivedAt)) / (1000 * 60 * 60);
        totalResponseTime += hours;
        responseCount++;
      }
    } else {
      stats.withoutReply++;
    }
    
    // Count contacts
    for (const participant of thread.participants) {
      const count = stats.topContacts.get(participant) || 0;
      stats.topContacts.set(participant, count + 1);
    }
    
    // Classify conversation type
    const subject = (thread.subject || '').toLowerCase();
    const body = thread.messages.map(m => m.bodyPreview || '').join(' ').toLowerCase();
    
    if (/문의|확인|요청|질문/.test(subject + body)) {
      stats.conversationTypes.inquiry++;
    } else if (/follow|후속|진행|업데이트/.test(subject + body)) {
      stats.conversationTypes.followUp++;
    } else if (/작업|할당|마감|일정/.test(subject + body)) {
      stats.conversationTypes.task++;
    } else if (/공유|안내|알림|참고/.test(subject + body)) {
      stats.conversationTypes.information++;
    } else {
      stats.conversationTypes.other++;
    }
  }
  
  stats.avgResponseTime = responseCount > 0 ? 
    Math.round(totalResponseTime / responseCount * 10) / 10 : 0;
  
  // Convert top contacts to sorted array
  stats.topContacts = Array.from(stats.topContacts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([email, count]) => ({ email, count }));
  
  return stats;
}

/**
 * Learn from user feedback on conversation classification
 */
export function learnFromFeedback(threads, feedback) {
  const patterns = {
    senderPatterns: new Map(),
    subjectPatterns: new Map(),
    timePatterns: {
      urgent: [],
      normal: [],
      low: []
    }
  };
  
  // Process feedback to learn patterns
  for (const fb of feedback) {
    const thread = threads.find(t => 
      t.messages.some(m => m.id === fb.messageId)
    );
    
    if (!thread) continue;
    
    // Learn sender patterns
    for (const msg of thread.messages) {
      const sender = msg.from?.toLowerCase();
      if (sender) {
        if (!patterns.senderPatterns.has(sender)) {
          patterns.senderPatterns.set(sender, { 
            total: 0, 
            statuses: {} 
          });
        }
        const senderStats = patterns.senderPatterns.get(sender);
        senderStats.total++;
        senderStats.statuses[fb.userStatus] = (senderStats.statuses[fb.userStatus] || 0) + 1;
      }
    }
    
    // Learn subject patterns
    const subjectKey = normalizeSubject(thread.subject);
    if (subjectKey) {
      if (!patterns.subjectPatterns.has(subjectKey)) {
        patterns.subjectPatterns.set(subjectKey, {
          total: 0,
          statuses: {}
        });
      }
      const subjectStats = patterns.subjectPatterns.get(subjectKey);
      subjectStats.total++;
      subjectStats.statuses[fb.userStatus] = (subjectStats.statuses[fb.userStatus] || 0) + 1;
    }
  }
  
  return patterns;
}

/**
 * Apply learned patterns to classify new conversations
 */
export function applyLearnedPatterns(thread, learnedPatterns) {
  const scores = {
    urgent: 0,
    active: 0,
    waiting: 0,
    done: 0
  };
  
  // Check sender patterns
  for (const msg of thread.messages) {
    const sender = msg.from?.toLowerCase();
    if (sender && learnedPatterns.senderPatterns.has(sender)) {
      const senderStats = learnedPatterns.senderPatterns.get(sender);
      for (const [status, count] of Object.entries(senderStats.statuses)) {
        scores[status] += (count / senderStats.total) * 2;
      }
    }
  }
  
  // Check subject patterns
  const subjectKey = normalizeSubject(thread.subject);
  if (subjectKey && learnedPatterns.subjectPatterns.has(subjectKey)) {
    const subjectStats = learnedPatterns.subjectPatterns.get(subjectKey);
    for (const [status, count] of Object.entries(subjectStats.statuses)) {
      scores[status] += (count / subjectStats.total) * 3;
    }
  }
  
  // Return highest scoring status
  const maxStatus = Object.entries(scores)
    .sort((a, b) => b[1] - a[1])[0];
  
  return {
    status: maxStatus[0],
    confidence: maxStatus[1],
    scores
  };
}

/**
 * Generate conversation summary for AI analysis
 */
export function generateConversationSummary(thread) {
  const summary = {
    subject: thread.subject,
    participantCount: thread.participants.length,
    messageCount: thread.messageCount,
    hasReply: thread.hasReply,
    timespan: thread.messages.length > 0 ? {
      start: thread.messages[0].receivedAt,
      end: thread.messages[thread.messages.length - 1].receivedAt
    } : null,
    keyPoints: []
  };
  
  // Extract key points from messages
  for (const msg of thread.messages.slice(0, 5)) { // Last 5 messages
    summary.keyPoints.push({
      from: msg.fromName || msg.from,
      date: msg.receivedAt,
      preview: (msg.bodyPreview || msg.body || '').slice(0, 200)
    });
  }
  
  return summary;
}
