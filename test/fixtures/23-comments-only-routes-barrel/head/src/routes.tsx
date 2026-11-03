/** The route table: one entry per page. */
import { createBrowserRouter } from 'react-router-dom'
import { AppLayout } from '@/layouts/AppLayout'
import HomePage from './pages/HomePage'
import { ProductsPage } from './pages/ProductsPage'
import { AboutPage } from '@/pages/AboutPage'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'products', element: <ProductsPage /> },
      { path: 'about', Component: AboutPage },
      { path: 'settings', lazy: () => import('./pages/SettingsPage') }
    ]
  }
])
