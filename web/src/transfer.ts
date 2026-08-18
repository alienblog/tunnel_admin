import { useStore, type TransferRec } from './store';
import { getDesktop } from './desktop';

/**
 * 传输工具：上传（XHR 带进度）/ 下载（fetch 流式带进度），
 * 均写入 store.transfers 供传输管理器展示。
 */

/** 桌面端任务栏进度：取所有 running 传输的平均进度；无进行中传输时清除 */
function syncTransferProgress(): void {
  const d = getDesktop();
  if (!d) return;
  const running = useStore.getState().transfers.filter((t) => t.status === 'running' && t.size > 0);
  if (running.length === 0) {
    d.setProgress(null);
    return;
  }
  const total = running.reduce((a, t) => a + t.size, 0);
  const done = running.reduce((a, t) => a + t.transferred, 0);
  d.setProgress(total > 0 ? done / total : null);
}

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
        syncTransferProgress();
      }
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        useStore.getState().updateTransfer(id, { transferred: f.size, status: 'done', doneAt: Date.now() });
        syncTransferProgress();
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
      syncTransferProgress();
      reject(new Error(msg));
    };
    xhr.onerror = () => {
      useStore.getState().updateTransfer(id, { status: 'error', error: '网络错误' });
      syncTransferProgress();
      reject(new Error('网络错误'));
    };
    xhr.send(f);
  });
}

/** 下载（桌面端流式直写本地文件；Web 端 fetch 流式 + Blob 浏览器下载），自动记录传输状态 */
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
  const update = (p: Partial<TransferRec>): void => {
    useStore.getState().updateTransfer(id, p);
    syncTransferProgress();
  };
  // 桌面端：浏览器下载完成后记录保存路径（供传输管理器「定位文件」）
  const desktop = getDesktop();
  const unsub = desktop?.onDownloadDone((info) => {
    if (info.name === name) {
      update({ localPath: info.path });
      unsub?.();
    }
  });
  try {
    if (desktop) {
      // 桌面端：开始下载前决定目录（ask 弹框 / default 直下），边读边写本地文件，
      // 不经浏览器下载、不攒 Blob（大文件不占内存）。
      const st = await desktop.downloadStart(name);
      if (!st.ok || !st.token) {
        update({ status: 'error', error: st.canceled ? '已取消（未选择保存目录）' : '无法确定保存位置' });
        return;
      }
      const token = st.token;
      try {
        const res = await fetch(url);
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `下载失败 (${res.status})`);
        }
        const total = Number(res.headers.get('content-length') ?? 0);
        update({ size: total });
        const reader = res.body?.getReader();
        if (!reader) throw new Error('响应无内容');
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          await desktop.downloadData(token, value);
          update({ transferred: received });
        }
        await desktop.downloadEnd(token);
        update({ transferred: received, size: total || received, status: 'done', localPath: st.path, doneAt: Date.now() });
      } catch (err) {
        // 传输失败：删除半成品文件
        await desktop.downloadCancel(token).catch(() => {});
        throw err;
      }
      return;
    }
    // Web 端：fetch 全量 → Blob → 浏览器下载
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
      update({ transferred: received });
    }
    const blob = new Blob(chunks as unknown as BlobPart[]);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    update({ transferred: received, size: total || received, status: 'done', doneAt: Date.now() });
  } catch (err) {
    update({ status: 'error', error: (err as Error).message });
    throw err;
  }
}
