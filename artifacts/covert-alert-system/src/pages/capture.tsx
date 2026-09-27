import { useState } from 'react';
import { Camera, Check, Clock3, Eye, Mic, Video } from 'lucide-react';
import { SectionKicker } from '@/components/field-ui';
import {
  useCapturePolicy,
  type CapturePolicy,
  type CaptureSetting,
  type CaptureTiming,
} from '@/hooks/use-capture-policy';

const KINDS = [
  {
    key: 'audio' as const,
    label: 'Audio',
    icon: Mic,
    detail: 'Rolling 30-second clips, up to 3 minutes per trigger. Mic indicator shows in the status bar while recording.',
  },
  {
    key: 'photo' as const,
    label: 'Photo',
    icon: Camera,
    detail: 'One still from the rear camera, no camera UI on screen. Camera indicator shows briefly.',
  },
  {
    key: 'video' as const,
    label: 'Video',
    icon: Video,
    detail: 'One 20-second clip from the rear camera. Camera (and mic) indicators show while recording.',
  },
];

const SETTING_LABELS: Record<CaptureSetting, string> = {
  off: 'Off',
  trigger: 'Start on trigger',
  responder: 'Only when a responder asks',
};

const TIMING_LABELS: Record<CaptureTiming, { label: string; detail: string }> = {
  immediate: {
    label: 'Immediate',
    detail: 'Capture begins the moment the alert triggers — catches the first ~60 seconds, while the screen is typically still on and the phone in someone\'s hand.',
  },
  'screen-off': {
    label: 'On screen-off',
    detail: 'Capture begins only when the screen next turns off after the trigger — the stealth-first option. If the screen is already off, capture starts right away.',
  },
};

/**
 * Evidence capture playground: per-type toggles and the start-timing mode,
 * applied by the handset on its next server contact — no app reinstall. The
 * owner runs the same scenario twice (immediate vs screen-off) and compares
 * the actual evidence and visibility of each.
 */
export default function Capture() {
  const { policy, loaded, saving, error, save } = useCapturePolicy();
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const apply = async (changes: Partial<CapturePolicy>) => {
    const next = { ...policy, ...changes };
    setSaveError(null);
    try {
      await save(next);
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 2200);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : 'The capture policy could not be saved.');
    }
  };

  return (
    <div className="mx-auto max-w-[980px]">
      <section className="fade-up border-b border-[#cfd2c9] pb-7">
        <div className="mb-4 flex items-center gap-3"><SectionKicker>Evidence capture / playground</SectionKicker></div>
        <h1 className="font-display text-3xl font-extrabold tracking-[-0.05em] sm:text-5xl">Try each capture type for real.</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[#687271]">
          Independent toggles for audio, photo, and video. The handset fetches this policy on every trigger
          and server contact, so a change here takes effect on the next alert with no app reinstall.
          Captured clips land on the incident's evidence panel, downloadable from the incidents view.
        </p>
      </section>

      {loaded && (
        <section className="fade-up fade-up-1 mt-6 space-y-5">
          <div className="border border-[#d7d8d0] bg-[#fbfbf7] p-5">
            <SectionKicker>Capture types</SectionKicker>
            <div className="mt-4 space-y-4">
              {KINDS.map(({ key, label, icon: Icon, detail }) => (
                <div key={key} className="border border-[#e0e1da] bg-[#f7f7f1] p-4" data-testid={`panel-capture-${key}`}>
                  <div className="flex items-center gap-2">
                    <Icon size={16} className="text-[#203c49]" />
                    <h2 className="text-sm font-bold text-[#203c49]">{label}</h2>
                    <span className={`ml-auto border px-2 py-0.5 font-mono-ui text-[10px] uppercase tracking-[0.08em] ${policy[key] === 'off' ? 'border-[#c6cbc3] text-[#687271]' : 'border-[#b9d8c5] bg-[#e1efe5] font-bold text-[#236047]'}`} data-testid={`status-capture-${key}`}>
                      {SETTING_LABELS[policy[key]]}
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-[#687271]">{detail}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {(['off', 'trigger', 'responder'] as const).map((setting) => (
                      <button
                        key={setting}
                        disabled={saving}
                        onClick={() => { void apply({ [key]: setting }); }}
                        className={`border px-3 py-2 font-mono-ui text-[10px] uppercase tracking-[0.1em] transition-colors disabled:opacity-40 ${policy[key] === setting ? 'border-[#203c49] bg-[#203c49] text-[#f2f0e6]' : 'border-[#c6cbc3] text-[#687271] hover:border-[#203c49]'}`}
                        data-testid={`button-capture-${key}-${setting}`}
                      >
                        {SETTING_LABELS[setting]}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="border border-[#d7d8d0] bg-[#fbfbf7] p-5">
            <div className="flex items-center gap-2">
              <Clock3 size={16} className="text-[#203c49]" />
              <SectionKicker>Capture start timing</SectionKicker>
            </div>
            <p className="mt-3 text-xs leading-5 text-[#687271]">
              Applies to every enabled capture type. Run the same scenario twice — once immediate, once
              deferred — and compare which evidence each actually catches and how visible each start is.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {(['immediate', 'screen-off'] as const).map((timing) => (
                <button
                  key={timing}
                  disabled={saving}
                  onClick={() => { void apply({ timing }); }}
                  className={`border p-4 text-left transition-colors disabled:opacity-40 ${policy.timing === timing ? 'border-[#203c49] bg-[#203c49] text-[#f2f0e6]' : 'border-[#c6cbc3] bg-[#f7f7f1] text-[#687271] hover:border-[#203c49]'}`}
                  data-testid={`button-capture-timing-${timing}`}
                >
                  <span className="flex items-center gap-2 text-xs font-bold">
                    {policy.timing === timing && <Check size={13} />}
                    {TIMING_LABELS[timing].label}
                  </span>
                  <span className={`mt-2 block text-[11px] leading-4 ${policy.timing === timing ? 'text-[#c2cec7]' : 'text-[#687271]'}`}>
                    {TIMING_LABELS[timing].detail}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="border border-[#e8c880] bg-[#fff8e7] p-5">
            <div className="flex gap-3">
              <Eye size={17} className="mt-0.5 shrink-0 text-[#a06712]" />
              <div>
                <p className="text-sm font-bold text-[#765013]">The OS indicator stays — by design.</p>
                <p className="mt-1 text-xs leading-5 text-[#765013]">
                  Stock Android always shows the green mic/camera indicator while recording; it cannot be hidden
                  and this build makes no attempt to. Capture never opens app UI: the indicator is the only
                  on-screen trace. Responder-requested capture runs when the handset next contacts the server —
                  if the phone sits idle in the background, Android may refuse a mic/camera start, and the
                  handset reports the exact restriction to the incident journal so it is measured, not assumed.
                </p>
              </div>
            </div>
          </div>

          {(error || saveError) && (
            <p role="alert" className="border border-[#914136] bg-[#914136]/10 px-3 py-2 text-xs font-bold text-[#914136]" data-testid="text-capture-error">
              {saveError ?? error}
            </p>
          )}
          {savedFlash && (
            <p className="flex items-center gap-1.5 text-[11px] font-semibold text-[#236047]" data-testid="text-capture-saved">
              <span className="h-1.5 w-1.5 rounded-full bg-[#4e9a70]" />
              Policy saved — the handset applies it on its next server contact.
            </p>
          )}
          {policy.updatedAt && (
            <p className="font-mono-ui text-[10px] uppercase tracking-[0.1em] text-[#687271]">
              Last changed {new Date(policy.updatedAt).toLocaleString()}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
