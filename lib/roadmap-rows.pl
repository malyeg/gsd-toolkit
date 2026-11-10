#!/usr/bin/env perl
#
# roadmap-rows.pl — give a freshly claimed phase its ROADMAP.md bookkeeping rows.
#
# `gsd_run query phase.add` / `phase.insert` (gsd-core) write only the `### Phase N:`
# section (plus a `- [ ] TBD (run /gsd-plan-phase N …)` line). No checklist row
# and no Progress row — so gsdt-doctor reports T022/T023, and phase.complete,
# which ticks the FIRST unticked line matching "Phase N", would tick the TBD line
# (T021). lib/roadmap-audit.pl detects exactly that; this script prevents it.
#
# Usage: roadmap-rows.pl <ROADMAP.md> <N>
#
# Adds, only when absent:
#   - [ ] **Phase N: <title>**         among the checklist rows, in numeric order
#   | N. <title> | … |                 in the `| Phase | … |` table, same columns
# The title comes from the `### Phase N:` heading. A roadmap with no checklist
# rows / no Progress table is left alone for that part — there is no house style
# to copy. Idempotent; writes the file only when it changed.

use strict;
use warnings;

my ($path, $n) = @ARGV;
defined $n or die "usage: roadmap-rows.pl <ROADMAP.md> <N>\n";
open my $fh, '<', $path or die "cannot read $path\n";
my @L = <$fh>;
close $fh;

my $qn = quotemeta $n;
my ($title) = map { /^#{2,4}\s*Phase\s+$qn\s*:\s*(.*?)\s*$/ ? $1 : () } @L;
defined $title or die "no '### Phase $n:' heading in $path\n";

# Numeric order for "7", "7.1", "10": compare part by part.
sub before {
    my ($a, $b) = @_;
    my @a = split /\./, $a; my @b = split /\./, $b;
    for my $i (0 .. 1) {
        my ($x, $y) = ($a[$i] // -1, $b[$i] // -1);
        return $x < $y if $x != $y;
    }
    return 0;
}

# The same phase however it is padded: 2 = 02, 2.1 = 02.1 (and 2 != 2.1).
sub same { my ($a, $b) = @_; !before($a, $b) && !before($b, $a) }

my $changed = 0;

# ── checklist row ────────────────────────────────────────────────────────────
my $row_re = qr/^(\s*)-\s*\[[ x]\]\s*\*\*Phase\s+(\d+(?:\.\d+)?)\s*:/;
my @rows = grep { $L[$_] =~ $row_re } 0 .. $#L;
if (@rows && !grep { same(($L[$_] =~ $row_re)[1], $n) } @rows) {
    my ($at, $indent) = ($rows[-1] + 1, ($L[$rows[-1]] =~ $row_re)[0]);
    for my $i (@rows) {
        my ($ind, $num) = $L[$i] =~ $row_re;
        if (before($n, $num)) { ($at, $indent) = ($i, $ind); last; }
    }
    splice @L, $at, 0, "$indent- [ ] **Phase $n: $title**\n";
    $changed = 1;
}

# ── Progress table row ───────────────────────────────────────────────────────
my ($head) = grep { $L[$_] =~ /^\|\s*Phase\s*\|/i } 0 .. $#L;
if (defined $head) {
    my $end = $head + 1;
    $end++ while $end <= $#L && $L[$end] =~ /^\|/;
    my @body = grep { $L[$_] =~ /^\|\s*\d/ } $head + 2 .. $end - 1;
    # compare the row's whole number: "| 2.1. …" is not phase 2
    unless (grep { my ($r) = $L[$_] =~ /^\|\s*(\d+(?:\.\d+)?)/; same($r, $n) } @body) {
        my @cols = grep { length } map { s/^\s+|\s+$//gr } split /\|/, $L[$head];
        (my $cell = $title) =~ s/\|/\//g;
        my @cells = ("$n. $cell");
        for my $c (@cols[1 .. $#cols]) {
            push @cells, $c =~ /status/i ? 'Not started'
                       : $c =~ /plan/i   ? '0/TBD'
                       :                   '-';
        }
        my $at = $end;
        for my $i (@body) {
            my ($num) = $L[$i] =~ /^\|\s*(\d+(?:\.\d+)?)/;
            if (before($n, $num)) { $at = $i; last; }
        }
        splice @L, $at, 0, '| ' . join(' | ', @cells) . " |\n";
        $changed = 1;
    }
}

if ($changed) {
    open my $out, '>', $path or die "cannot write $path\n";
    print $out @L;
    close $out;
}
