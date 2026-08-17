import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap shrink-0",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary/15 text-primary",
        ok: "border-transparent bg-ok/15 text-ok",
        warn: "border-transparent bg-warn/15 text-warn",
        danger: "border-transparent bg-danger/15 text-danger",
        outline: "text-muted-foreground border-border",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
