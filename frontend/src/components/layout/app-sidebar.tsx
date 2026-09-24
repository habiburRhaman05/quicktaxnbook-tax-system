'use client';

import { AppBrand } from '@/components/layout/app-brand';
import LanguageSwitcher from '@/components/shared/language-switcher';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { UserDropdown } from '@/components/shared/user-dropdown';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { useAuth } from '@/features/auth/hooks/auth-provider';
import { Icon, type IconName } from '@/components/icons/app-icons';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';

export interface AppNavItem {
  id: string;
  label: string;
  href: string;
  icon: IconName;
  /** Exact match only - for a nav item that would otherwise capture nested routes it shouldn't. */
  exact?: boolean;
}

export interface AppNavGroup {
  label?: string;
  items: AppNavItem[];
}

interface AppSidebarProps {
  brandHref: string;
  navGroups: AppNavGroup[];
  profileHref: string;
  mobileTitle?: string;
  /** Shown under the app brand, so it's always clear whose workspace is
   * currently open - plain text (firm name) or an interactive entity
   * switcher (client portal, when the login has access to more than one
   * entity). */
  contextSlot?: ReactNode;
}

export function AppSidebar({
  brandHref,
  navGroups,
  profileHref,
  mobileTitle,
  contextSlot,
}: AppSidebarProps) {
  const t = useTranslations();
  const { signOut } = useAuth();
  const pathname = usePathname();
  const { toggleSidebar, setOpenMobile } = useSidebar();

  const [logoutDialogOpen, setLogoutDialogOpen] = useState(false);

  const isActive = (item: AppNavItem) =>
    item.exact
      ? pathname === item.href
      : pathname === item.href || pathname.startsWith(`${item.href}/`);

  const activeLabel = useMemo(() => {
    for (const group of navGroups) {
      const match = group.items.find((item) => isActive(item));
      if (match) return match.label;
    }
    return mobileTitle ?? t('navigation.dashboard');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, navGroups, mobileTitle]);

  const logoutLabel = t('navigation.logout');

  const handleConfirmLogout = () => {
    setLogoutDialogOpen(false);
    setOpenMobile(false);
    void signOut();
  };

  const renderContent = (onItemClick?: () => void) => (
    <div className="flex h-full min-w-0 flex-col bg-transparent text-start">
      <SidebarHeader>
        <AppBrand href={brandHref} onClick={onItemClick} />
        {contextSlot}
      </SidebarHeader>

      <SidebarContent>
        {navGroups.map((group, groupIndex) => (
          <SidebarGroup key={group.label ?? `group-${groupIndex}`}>
            {group.label ? (
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            ) : null}
            <SidebarMenu>
              {group.items.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive(item)}
                    tooltip={item.label}
                    onClick={onItemClick}
                  >
                    <Link href={item.href}>
                      <Icon
                        name={item.icon}
                        className="size-4.5 shrink-0"
                        weight="fill"
                      />
                      <span className="truncate group-data-[state=collapsed]:hidden">
                        {item.label}
                      </span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname === profileHref}
              tooltip={t('navigation.profile')}
              onClick={onItemClick}
            >
              <Link href={profileHref}>
                <Icon
                  name="userCircle"
                  className="size-4.5 shrink-0"
                  weight="fill"
                />
                <span className="truncate group-data-[state=collapsed]:hidden">
                  {t('navigation.profile')}
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>

          <SidebarMenuItem>
            <SidebarMenuButton
              variant="destructive"
              tooltip={logoutLabel}
              onClick={() => {
                setLogoutDialogOpen(true);
                onItemClick?.();
              }}
            >
              <Icon name="logout" className="size-4.5 shrink-0" weight="fill" />
              <span className="truncate group-data-[state=collapsed]:hidden">
                {logoutLabel}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </div>
  );

  return (
    <>
      <div className="fixed inset-x-0 top-0 z-50 flex h-app-header items-center justify-between border-b border-border/40 bg-background/80 px-4 md:hidden dark:border-border/60 dark:bg-card">
        <div className="flex flex-1 items-center justify-start gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="-ms-1 h-8 w-8"
            onClick={toggleSidebar}
            aria-label={t('sidebar.menu')}
          >
            <Icon name="menu" className="h-5 w-5" />
          </Button>
          <h1 className="truncate text-lg font-semibold">{activeLabel}</h1>
        </div>

        <div className="flex items-center gap-1">
          <ThemeToggle />
          <LanguageSwitcher />
          <UserDropdown
            onlyAvatar
            contentClassName="w-56"
            profileHref={profileHref}
            onLogout={() => setOpenMobile(false)}
          />
        </div>
      </div>

      <Sidebar>{renderContent(() => setOpenMobile(false))}</Sidebar>

      <Dialog open={logoutDialogOpen} onOpenChange={setLogoutDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('auth.logout.title')}</DialogTitle>
            <DialogDescription>{t('auth.logout.confirm')}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4 flex-row justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline" size="sm">
                {t('common.cancel')}
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleConfirmLogout}
            >
              {t('common.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
