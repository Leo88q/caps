import { RouterProvider } from 'react-router-dom';
import { Providers } from './providers';
import { router } from './router';
import '@/shared/ui/theme.css';
import '@/shared/ui/layout.css';

export default function App() {
  return (
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  );
}
