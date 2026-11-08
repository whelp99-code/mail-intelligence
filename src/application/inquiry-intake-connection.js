import { readInquiryNotificationTestBand, INQUIRY_NOTIFY_RECIPIENT } from './inquiry-notification-draft.js';

function inquiryRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function inquirySource(body) {
  if (!inquiryRecord(body)) return {};
  if (inquiryRecord(body.inquiry)) return body.inquiry;
  if (inquiryRecord(body.submission)) return body.submission;
  return body;
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function contactOf(source) {
  if (text(source.contact).trim()) return source.contact;
  if (text(source.email).trim()) return source.email;
  return text(source.phone);
}

function inquiryText(source) {
  if (typeof source.body === 'string') return source.body;
  return text(source.currentSituation);
}

// Operational intake input. Caller fetch, test band, approval, and notify config are never copied from the request.
export function inquiryNotificationInput(body) {
  const source = inquirySource(body);
  return {
    inquiry: {
      id: text(source.id),
      name: text(source.name),
      contact: contactOf(source),
      body: inquiryText(source),
      receivedAt: text(source.receivedAt),
    },
    recipient: INQUIRY_NOTIFY_RECIPIENT,
    store: { persistent: false, durableDedup: false },
  };
}

export function inquiryIntakeConnectionResult(notification) {
  return {
    ok: false,
    operationalSend: false,
    sent: notification?.sent === true,
    confirmed: notification?.confirmed === true,
    accepted: notification?.accepted === true,
    failureCode: notification?.failureCode || null,
    inquiryId: typeof notification?.inquiryId === 'string' ? notification.inquiryId : null,
    serverWired: true,
    productionConnected: false,
    persistentDedupRecorded: false,
    persistentDedup: 'absent',
    productionBlockers: Array.isArray(notification?.productionBlockers) ? [...notification.productionBlockers] : [],
    testBandReceiptCount: readInquiryNotificationTestBand().length,
  };
}
