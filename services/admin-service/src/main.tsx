import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './styles.css';

// BrowserRouter `basename` matches the Vite `base: '/admin/'` and the NGINX
// route — so all client routes resolve under /admin/ (FR-WZD-01 first-run
// redirect targets /admin/wizard, the PWA start_url is /admin/).
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter basename="/admin">
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);