import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
// react-day-picker's stylesheet must be imported BEFORE ./styles.css: our
// `.datefield__popover .rdp-root` variable overrides re-theme the calendar with
// the design tokens, and a later source position keeps them winning even for
// equal-specificity declarations. (The overrides are also scoped one class
// deeper than the library's `.rdp-root`, so the win does not depend on this
// order alone — the ordering is belt-and-braces, the specificity is the belt.)
import 'react-day-picker/style.css';
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