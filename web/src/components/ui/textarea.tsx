import * as React from "react";
import { cn } from "../../lib/utils.js";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          "flex w-full rounded-lg border border-input bg-input/40 px-3 py-2.5 text-[15px] leading-relaxed",
          "placeholder:text-muted-foreground/70 outline-none transition-colors",
          "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    );
  },
);

export { Textarea };
