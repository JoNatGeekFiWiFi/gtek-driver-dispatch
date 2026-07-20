import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login.jsx';
import Dispatch from './pages/Dispatch.jsx';
import Driver from './pages/Driver.jsx';
import { getUser, getToken } from './api.js';

function Home() {
  const user = getUser();
  if (!getToken() || !user) return <Navigate to="/login" replace />;
  return <Navigate to={user.role === 'driver' ? '/driver' : '/dispatch'} replace />;
}

function Protected({ role, children }) {
  const user = getUser();
  if (!getToken() || !user) return <Navigate to="/login" replace />;
  if (role && user.role !== role) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route
          path="/dispatch"
          element={<Protected role="dispatcher"><Dispatch /></Protected>}
        />
        <Route
          path="/driver"
          element={<Protected role="driver"><Driver /></Protected>}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
