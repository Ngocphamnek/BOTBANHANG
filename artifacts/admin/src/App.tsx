import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { Layout } from '@/components/layout';
import { Dashboard } from '@/pages/dashboard';
import { ProductsPage } from '@/pages/products/index';
import { ProductDetailPage } from '@/pages/products/[id]';
import { OrdersPage } from '@/pages/orders/index';
import { OrderDetailPage } from '@/pages/orders/[id]';
import { UsersPage } from '@/pages/users/index';
import { SyncPage } from '@/pages/sync';
import GcmmoConnect from '@/pages/gcmmo-connect';
import { SettingsPage } from '@/pages/settings';
import { WalletPage } from '@/pages/wallet/index';
import { SellersPage } from '@/pages/sellers/index';

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/products" component={ProductsPage} />
        <Route path="/products/:id" component={ProductDetailPage} />
        <Route path="/orders" component={OrdersPage} />
        <Route path="/orders/:id" component={OrderDetailPage} />
        <Route path="/users" component={UsersPage} />
        <Route path="/sync" component={SyncPage} />
        <Route path="/gcmmo-connect" component={GcmmoConnect} />
        <Route path="/settings" component={SettingsPage} />
        <Route path="/wallet" component={WalletPage} />
        <Route path="/sellers" component={SellersPage} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
