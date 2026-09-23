export const WORK_OBJECT_TYPES = Object.freeze(['account', 'engagement', 'activity', 'commitment']);
export const WORK_SYSTEMS = Object.freeze(['notion', 'cwos']);
export const WORK_LINK_STATUSES = Object.freeze(['candidate', 'confirmed', 'rejected', 'superseded']);

export function assertWorkSystemPort(port) {
  if (!port || typeof port.listMasters !== 'function') {
    throw Object.assign(new Error('Work system port must implement listMasters().'), { code: 'WORK_SYSTEM_PORT_INVALID' });
  }
  if (typeof port.proposeActivity !== 'function') {
    throw Object.assign(new Error('Work system port must implement proposeActivity().'), { code: 'WORK_SYSTEM_PORT_INVALID' });
  }
  return port;
}
