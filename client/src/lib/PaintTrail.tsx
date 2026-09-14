import { useEffect, useRef } from 'react';

const NEON_COLORS = ['#FF2E8A', '#16E5D9', '#B6FF3C', '#FF7A1A'];

/**
 * Leaves a fading trail of small paint droplets behind the cursor/finger,
 * per Block 8 "CURSOR / TOUCH TRAIL". Throttled to avoid spamming the DOM
 * with a div per pixel of movement — one droplet roughly every 40ms of
 * continuous motion, color picked at random per droplet from the neon set.
 *
 * Mount this once near the root of the app (see App.tsx), not per-screen.
 */
export function PaintTrail() {
  const lastSpawn = useRef(0);

  useEffect(() => {
    function spawnDroplet(x: number, y: number) {
      const dot = document.createElement('div');
      dot.className = 'cg-paint-dot';
      dot.style.left = `${x - 2}px`;
      dot.style.top = `${y - 2}px`;
      dot.style.background = NEON_COLORS[Math.floor(Math.random() * NEON_COLORS.length)];
      document.body.appendChild(dot);
      setTimeout(() => dot.remove(), 700);
    }

    function handleMove(x: number, y: number) {
      const now = performance.now();
      if (now - lastSpawn.current < 40) return;
      lastSpawn.current = now;
      spawnDroplet(x, y);
    }

    const onMouseMove = (e: MouseEvent) => handleMove(e.clientX, e.clientY);
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (t) handleMove(t.clientX, t.clientY);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('touchmove', onTouchMove);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('touchmove', onTouchMove);
    };
  }, []);

  return null; // pure side-effect component, renders nothing itself
}
