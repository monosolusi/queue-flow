import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './styles.css';

// BrowserRouter `basename` matches the Vite `base: '/tv/'` and the NGINX route.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter basename="/tv">
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);