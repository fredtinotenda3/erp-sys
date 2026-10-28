"use client";

import { Printer } from "lucide-react";

import { Button } from "@/components/ui/button";

export function PrintButton() {
  return (
    <Button type="button" variant="outline" data-print-hide onClick={() => window.print()}>
      <Printer /> Print
    </Button>
  );
}
