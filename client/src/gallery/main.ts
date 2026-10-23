import '../styles/tokens.css';
import '../styles/components.css';
import './gallery.css';
import { entries } from './entries.js';
import { renderGallery } from './render.js';

const app = document.querySelector<HTMLElement>('#gallery');
if (!app) throw new Error('gallery/index.html is missing the #gallery element');

renderGallery(app, entries);
app.dataset.ready = 'true';
