import type { ImageDraft } from '@orchardworks/agent-remote-web/browser';

export async function persistedPrompt(key: string) {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('agent-remote-image-drafts', 2);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<{ draft: ImageDraft | undefined; images: Array<{ blobBytes: ArrayBuffer }> }>((resolve, reject) => {
      const tx = database.transaction(['drafts', 'images'], 'readonly');
      const draft = tx.objectStore('drafts').get(key), images = tx.objectStore('images').getAll();
      tx.oncomplete = () => resolve({ draft: draft.result, images: images.result.filter(image => JSON.parse(image.key)[0] === key) });
      tx.onabort = () => reject(tx.error);
    });
  } finally { database.close(); }
}
