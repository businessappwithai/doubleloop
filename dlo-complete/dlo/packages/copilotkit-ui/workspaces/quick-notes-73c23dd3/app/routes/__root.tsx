import { RootRoute, Outlet } from '@tanstack/react-router';
import '../styles/app.css';

export const Route = new RootRoute({
  component: () => (
    <html>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Quick Notes</title>
      </head>
      <body>
        <Outlet />
      </body>
    </html>
  ),
});
