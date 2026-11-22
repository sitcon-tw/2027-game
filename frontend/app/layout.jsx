import { connection } from 'next/server';
import { Dashboard } from './dashboard.jsx';
import './styles.css';

export const metadata = {
  title: { default: '活動總覽 · 大地遊戲', template: '%s · 大地遊戲' },
  applicationName: '大地遊戲',
  icons: { icon: '/favicon.svg' },
};

export default async function RootLayout({ children }) {
  await connection(); // Next reads the gateway's CSP nonce on every document request.
  return (
    <html lang="zh-Hant">
      <body>
        <Dashboard>{children}</Dashboard>
      </body>
    </html>
  );
}
