import { Component, type ReactNode } from 'react';

/** 全局错误边界：渲染异常时显示错误信息与重试按钮，避免白屏 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-screen items-center justify-center bg-[#1e1e1e]">
          <div className="max-w-lg rounded-sm border border-[#f14c4c]/40 bg-[#3b1d1d] p-4 text-[12px] text-[#f14c4c]">
            <div className="mb-2 font-semibold">界面渲染出错</div>
            <div className="break-all font-mono text-[11px]">{this.state.error.message}</div>
            <button
              onClick={() => this.setState({ error: null })}
              className="mt-3 rounded-sm bg-[#0e639c] px-3 py-1 text-[12px] text-white hover:bg-[#1177bb]"
            >
              重试
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
