// Image bytes stay on this device until an explicit Send. IndexedDB avoids the
// small synchronous localStorage quota used for text and pending-send metadata.
let database;
function open() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('pocket-attachment-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts', { keyPath: 'threadId' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Screenshot storage is blocked'));
  });
  return database;
}
async function transaction(mode, operation) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('drafts', mode);
    const request = operation(tx.objectStore('drafts'));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Screenshot storage was interrupted'));
  });
}
export const loadAttachmentDrafts = () => transaction('readonly', store => store.getAll());
export const saveAttachmentDrafts = (threadId, images) => transaction('readwrite', store => images.length ? store.put({ threadId, images }) : store.delete(threadId));
export const clearAttachmentDrafts = () => transaction('readwrite', store => store.clear());
