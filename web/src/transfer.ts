import { useStore } from './store';
import { getDesktop } from './desktop';

/**
 * 传输工具：上传（XHR 带进度）/ 下载（fetch 流式带进度），
 * 均写入 store.transfers 供传输管理器展示。
 */

/** 上传单文件（XHR 带进度），自动记录传输状态；onProgress 供调用方 UI 显示百分比 */
export function uploadFileXHR(
  hostName: string,
  hostId: string,
  f: File,
  targetPath: string,
  onProgress?: (pct: number) => void,
): Promise<void> {
  const id = useStore.getState().addTransfer({
    direction: 'up',
    name: f.name,
    path: targetPath,
    hostName,
    size: f.size,
    transferred: 0,
    status: 'running',
  });
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/sftp/upload?hostId=${hostId}&path=${encodeURIComponent(targetPath)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        useStore.getState().updateTransfer(id, { transferred: e.loaded });
        onProgress?.(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        useStore.getState().updateTransfer(id, { transferred: f.size, status: 'done', doneAt: Date.now() });
        resolve();
        return;
      }
      let msg = '上传失败';
      try {
        msg = JSON.parse(xhr.responseText).error ?? msg;
      } catch {
        // 保持默认
      }
      useStore.getState().updateTransfer(id, { status: 'error', error: msg });
      reject(new Error(msg));
    };
    xhr.onerror = () => {
      useStore.getState().updateTransfer(id, { status: 'error', error: '网络错误' });
      reject(new Error('网络错误'));
    };
    xhr.send(f);
  });
}

/** 下载（fetch 流式 + Blob 保存），自动记录传输状态 */
export async function downloadWithProgress(
  hostName: string,
  url: string,
  name: string,
  path: string,
): Promise<void> {
  const id = useStore.getState().addTransfer({
    direction: 'down',
    name,
    path,
    hostName,
    size: 0,
    transferred: 0,
    status: 'running',
  });
  // 桌面端：浏览器下载完成后记录保存路径（供传输管理器「定位文件」）
  const desktop = getDesktop();
  const unsub = desktop?.onDownloadDone((info) => {
    if (info.name === name) {
      useStore.getState().updateTransfer(id, { localPath: info.path });
      unsub?.();
    }
  });
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `下载失败 (${res.status})`);
    }
    const total = Number(res.headers.get('content-length') ?? 0);
    const reader = res.body?.getReader();
    if (!reader) throw new Error('响应无内容');
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      useStore.getState().updateTransfer(id, { transferred: received });
    }
    const blob = new Blob(chunks as unknown as BlobPart[]);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    useStore.getState().updateTransfer(id, { transferred: received, size: total || received, status: 'done', doneAt: Date.now() });
  } catch (err) {
    useStore.getState().updateTransfer(id, { status: 'error', error: (err as Error).message });
    throw err;
  }
}
