import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router';
import { Layout } from './components/layout';
import { HomePage } from './routes/home';

// Route-level code splitting: the room page pulls in the player and IM stack; keep it off the home bundle.
const RoomPage = lazy(() => import('./routes/room'));
const HostPage = lazy(() => import('./routes/host'));
const AdminPage = lazy(() => import('./routes/admin'));
const LabPage = lazy(() => import('./routes/lab'));
const PayMockPage = lazy(() => import('./routes/pay-mock'));

const Loading = () => <div className="p-8 text-zinc-400">加载中…</div>;

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="room/:id" element={<Suspense fallback={<Loading />}><RoomPage /></Suspense>} />
        <Route path="host/:id" element={<Suspense fallback={<Loading />}><HostPage /></Suspense>} />
        <Route path="admin" element={<Suspense fallback={<Loading />}><AdminPage /></Suspense>} />
        <Route path="lab" element={<Suspense fallback={<Loading />}><LabPage /></Suspense>} />
        <Route path="pay/mock/:orderId" element={<Suspense fallback={<Loading />}><PayMockPage /></Suspense>} />
        <Route path="*" element={<div className="p-8">404</div>} />
      </Route>
    </Routes>
  );
}
