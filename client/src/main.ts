const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('index.html is missing the #app element');
app.dataset.ready = 'true';
