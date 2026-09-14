import { useState } from 'react';
import { SettingsIcon, SoundIcon } from '../lib/icons';
import { SprayCapToggle } from '../lib/buttons';

export function SettingsScreen() {
  const [sound, setSound] = useState(true);
  const [reducedFx, setReducedFx] = useState(false);
  const [theme, setTheme] = useState<'night' | 'day'>('night');

  return (
    <div className="cg-brick-bg" style={{ padding: 16, minHeight: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
        <SettingsIcon size={22} />
        <strong className="cg-heading" style={{ fontSize: 18 }}>Settings</strong>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderBottom: '1px solid #2a2a2a' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <SoundIcon size={22} on={sound} />
          Sound
        </span>
        <SprayCapToggle on={sound} onChange={setSound} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderBottom: '1px solid #2a2a2a' }}>
        <span>Reduce paint effects (motion sensitivity)</span>
        <SprayCapToggle on={reducedFx} onChange={setReducedFx} />
      </div>

      <div style={{ padding: '14px 0' }}>
        <p style={{ marginBottom: 8, color: '#888', fontSize: 13 }}>Theme</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => setTheme('night')}
            style={{ flex: 1, padding: 10, opacity: theme === 'night' ? 1 : 0.5 }}
          >
            Night alley
          </button>
          <button
            onClick={() => setTheme('day')}
            style={{ flex: 1, padding: 10, opacity: theme === 'day' ? 1 : 0.5 }}
          >
            Day mural
          </button>
        </div>
        <p style={{ fontSize: 11, color: '#555', marginTop: 8 }}>
          Theme switching only changes this selector for now — no light-mode
          stylesheet exists yet, this wiring is ready for one.
        </p>
      </div>
    </div>
  );
}
