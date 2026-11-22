import { notFound } from 'next/navigation';
import { Audit, Checkpoints, Event, Players, Stations } from '../views.jsx';
import { routes } from '../routes.js';

const views = { event: Event, players: Players, stations: Stations, checkpoints: Checkpoints, audit: Audit };

export async function generateMetadata({ params }) {
  const { view } = await params;
  return { title: routes.find(({ path }) => path === `/${view}`)?.title };
}

export default async function Page({ params }) {
  const { view } = await params;
  if (!Object.hasOwn(views, view)) notFound();
  const View = views[view];
  return <View />;
}
