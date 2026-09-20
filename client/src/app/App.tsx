import { RouterProvider } from 'react-router-dom';
import { Providers } from './providers';
import { router } from './router';
import '@fontsource/rubik-spray-paint/latin-400.css';
import '@fontsource/rubik-spray-paint/cyrillic-400.css';
import '@fontsource/rubik-wet-paint/latin-400.css';
import '@fontsource/rubik-wet-paint/cyrillic-400.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/cyrillic-400.css';
import '@fontsource/jetbrains-mono/latin-700.css';
import '@fontsource/jetbrains-mono/cyrillic-700.css';
import '@/shared/ui/theme.css';
import '@/shared/ui/layout.css';
import '@/shared/ui/street-kit.css';
import '@/shared/ui/street-apply.css';
import { StreetFilters } from '@/shared/ui/street-filters';

export default function App() {
  return (
    <Providers>
      <StreetFilters />
      <RouterProvider router={router} />
    </Providers>
  );
}
