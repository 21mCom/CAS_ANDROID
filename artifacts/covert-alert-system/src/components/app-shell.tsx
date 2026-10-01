import { useState, type ReactNode } from 'react';
import { Activity, Camera, ClipboardCheck, Command, FileClock, LayoutDashboard, Mail, Menu, MessageSquareText, Radio, ShieldAlert, Users, X } from 'lucide-react';
import { Link, useLocation } from 'wouter';

// `testId` pins each nav selector to the value it had when the labels were
// engineer-flavored, so copy changes never break tests or e2e specs.
const navItems = [
  { href: '/', label: 'Overview', shortLabel: 'Overview', icon: LayoutDashboard, testId: 'link-nav-overview' },
  { href: '/gates', label: 'Readiness checks', shortLabel: 'Checks', icon: Radio, testId: 'link-nav-feasibility-gates' },
  { href: '/incidents', label: 'Alerts', shortLabel: 'Alerts', icon: FileClock, testId: 'link-nav-test-incidents' },
  { href: '/capture', label: 'Evidence capture', shortLabel: 'Capture', icon: Camera, testId: 'link-nav-evidence-capture' },
  { href: '/setup', label: 'Setup checklist', shortLabel: 'Setup', icon: ClipboardCheck, testId: 'link-nav-owner-setup' },
  { href: '/responders', label: 'Responders', shortLabel: 'Responders', icon: Users, testId: 'link-nav-responders' },
  { href: '/messages', label: 'Alert messages', shortLabel: 'Messages', icon: MessageSquareText, testId: 'link-nav-alert-text' },
  { href: '/email', label: 'Email alerts', shortLabel: 'Email', icon: Mail, testId: 'link-nav-email-delivery' },
];

export function AppShell({ children, onRunTest }: { children: ReactNode; onRunTest: () => void }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [justRan, setJustRan] = useState(false);

  const runTest = () => {
    onRunTest();
    setJustRan(true);
    window.setTimeout(() => setJustRan(false), 2600);
  };

  const currentLabel = navItems.find((item) => item.href === location)?.label ?? 'Overview';

  return (
    <div className="min-h-[100dvh] bg-[#f1f0e9] text-[#203c49]">
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-[250px] flex-col bg-[#203c49] text-[#f2f0e6] transition-transform duration-300 lg:translate-x-0 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex h-[92px] items-center justify-between border-b border-[#3a5962] px-6">
          <Link href="/" className="flex items-center gap-3" data-testid="link-brand">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#e8a629] text-[#e8a629]"><ShieldAlert size={19} /></span>
            <span><strong className="block font-display text-[15px] font-extrabold tracking-[0.02em]">CovertAlert</strong><span className="text-[10px] font-semibold text-[#9eb7ad]">Owner console</span></span>
          </Link>
          <button className="text-[#a7bab2] lg:hidden" onClick={() => setMobileOpen(false)} aria-label="Close navigation" data-testid="button-close-navigation"><X size={18} /></button>
        </div>
        <div className="px-5 pt-7">
          <p className="mb-3 text-[10px] font-bold tracking-[0.08em] text-[#8ca69f]">Your console</p>
          <nav className="space-y-1" aria-label="Primary navigation">
            {navItems.map(({ href, label, icon: Icon, testId }) => {
              const active = location === href;
              return <Link key={href} href={href} onClick={() => setMobileOpen(false)} className={`group flex items-center gap-3 rounded-lg border-l-2 px-3 py-3 text-sm font-semibold transition-colors ${active ? 'border-[#e8a629] bg-[#2d4a55] text-[#ffd067]' : 'border-transparent text-[#b8c5bf] hover:bg-[#294650] hover:text-[#f2f0e6]'}`} data-testid={testId}><Icon size={17} strokeWidth={active ? 2.3 : 1.8} /><span>{label}</span>{active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-[#e8a629]" />}</Link>;
            })}
          </nav>
        </div>
        <div className="mt-auto border-t border-[#3a5962] px-5 py-5">
          <div className="mb-4 flex items-center gap-2 text-[11px] text-[#aec0b8]"><span className="h-2 w-2 rounded-full bg-[#75b28f]" /> Connected — records are saved on the server</div>
          <div className="rounded-xl border border-[#3a5962] bg-[#1b3440] p-3">
            <div className="flex items-center justify-between"><span className="text-[10px] font-bold tracking-[0.06em] text-[#8ca69f]">Phone on test</span><Activity size={13} className="text-[#e8a629]" /></div>
            <p className="mt-2 font-display text-sm font-bold text-[#f2f0e6]">Google Pixel 11</p>
            <p className="mt-1 text-[11px] text-[#8ca69f]">stock Android · managed</p>
          </div>
          <p className="mt-5 text-[10px] leading-4 text-[#79918b]">Alerts triggered from this console are real — your responders are notified. Handle the trigger buttons with care.</p>
        </div>
      </aside>

      {mobileOpen && <button className="fixed inset-0 z-30 bg-[#102630]/45 lg:hidden" onClick={() => setMobileOpen(false)} aria-label="Close navigation overlay" data-testid="button-navigation-overlay" />}
      <div className="lg:pl-[250px]">
        <header className="sticky top-0 z-20 flex h-[68px] items-center justify-between border-b border-[#d7d8d0] bg-[#f6f5ef]/95 px-5 backdrop-blur-md sm:px-8">
          <button className="mr-3 text-[#203c49] lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation" data-testid="button-open-navigation"><Menu size={21} /></button>
          <div className="flex items-center gap-2 text-[11px] font-semibold text-[#687271]"><span className="hidden sm:inline">CovertAlert</span><span className="hidden text-[#b0b5ad] sm:inline">·</span><span className="hidden sm:inline">Console</span><span className="text-[#b0b5ad]">·</span><span className="text-[#a06712]">{currentLabel}</span></div>
          <div className="flex items-center gap-3">
            {justRan && <span className="hidden items-center gap-1.5 text-[11px] font-semibold text-[#236047] sm:flex"><span className="h-1.5 w-1.5 rounded-full bg-[#4e9a70]" />Test event recorded</span>}
            <button onClick={runTest} title="Writes a local test record only — no alert is sent and no responder is contacted." className="group inline-flex items-center gap-2 rounded-lg bg-[#e8a629] px-3 py-2 text-[11px] font-bold text-[#203c49] transition-transform hover:-translate-y-px active:translate-y-0" data-testid="button-run-test-incident"><Command size={14} /><span className="hidden sm:inline">Record test event</span><span className="sm:hidden">Test</span></button>
          </div>
        </header>
        <main className="instrument-grid min-h-[calc(100dvh-68px)] px-4 py-6 sm:px-8 sm:py-8 xl:px-12">{children}</main>
      </div>
      <div className="fixed bottom-0 left-0 right-0 z-20 flex border-t border-[#d7d8d0] bg-[#f6f5ef]/95 backdrop-blur-md lg:hidden">
        {navItems.map(({ href, shortLabel, icon: Icon, testId }) => <Link key={href} href={href} className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-[9px] font-bold ${location === href ? 'text-[#a06712]' : 'text-[#687271]'}`} data-testid={testId.replace('link-nav-', 'link-mobile-')}><Icon size={16} /><span>{shortLabel}</span></Link>)}
      </div>
    </div>
  );
}
