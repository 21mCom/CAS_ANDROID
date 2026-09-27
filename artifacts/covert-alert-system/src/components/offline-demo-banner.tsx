import { CloudOff } from 'lucide-react';

/**
 * Banner shown on every screen while the console is rendering the built-in
 * demo seed because the server itself could not be reached. The demo
 * fallback exists only for that genuinely-offline case, and it must never
 * read as live incident state.
 */
export function OfflineDemoBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      data-testid="banner-offline-demo"
      className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 border border-[#e8c880] bg-[#fff8e7] px-4 py-3"
    >
      <CloudOff size={16} className="shrink-0 text-[#a06712]" />
      <p className="text-xs font-bold text-[#765013]">Server unreachable — showing built-in demo data.</p>
      <p className="text-xs leading-5 text-[#765013]">
        Everything on this screen is sample/offline content, not live incident state.
      </p>
      <button
        type="button"
        data-testid="button-retry-offline-load"
        onClick={onRetry}
        className="ml-auto border border-[#a06712] px-3 py-1.5 text-xs font-bold text-[#765013] hover:border-[#765013]"
      >
        Retry connection
      </button>
    </div>
  );
}
