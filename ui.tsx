/**
 * Shared presentation pieces for the workbench.
 *
 * Layout convention throughout: a stack carries `padding` plus a
 * `background={<RoundedRectangle .../>}`. That is the combination the platform
 * documents; a stray modifier on the shape itself silently does nothing.
 */
import {
  Button,
  Circle,
  HStack,
  Image,
  Menu,
  RoundedRectangle,
  Slider,
  Spacer,
  Text,
  Toggle,
  VStack,
  ZStack,
} from "scripting"

import {
  ACCENT,
  ACCENT_GRADIENT,
  CARD_BG,
  CARD_STROKE,
  CHIP_BG,
  CHIP_ON_BG,
  CHIP_ON_FG,
  RADIUS_CARD,
  RADIUS_CHIP,
  RADIUS_WELL,
  WELL_BG,
} from "./theme"

export function Card({
  title,
  systemImage,
  trailing,
  children,
}: {
  title?: string
  systemImage?: string
  trailing?: any
  children?: any
}) {
  return (
    <VStack
      alignment="leading"
      spacing={12}
      padding={14}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
      background={
        <RoundedRectangle
          cornerRadius={RADIUS_CARD}
          fill={CARD_BG}
          stroke={{ shapeStyle: CARD_STROKE, strokeStyle: { lineWidth: 1 } }}
        />
      }
    >
      {title ? (
        <HStack spacing={7} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          {systemImage ? (
            <Image systemName={systemImage} font={13} foregroundStyle={ACCENT} />
          ) : null}
          <Text font={14} fontWeight="semibold" foregroundStyle="label">
            {title}
          </Text>
          <Spacer />
          {trailing}
        </HStack>
      ) : null}
      {children}
    </VStack>
  )
}

/** Inset well used for text areas and the image canvas. */
export function Well({
  children,
  padding = 10,
  radius = RADIUS_WELL,
}: {
  children?: any
  padding?: number
  radius?: number
}) {
  return (
    <VStack
      alignment="leading"
      spacing={8}
      padding={padding}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
      background={<RoundedRectangle cornerRadius={radius} fill={WELL_BG} />}
    >
      {children}
    </VStack>
  )
}

export function FieldLabel({ text, hint }: { text: string; hint?: string }) {
  return (
    <HStack spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      <Text font={12} fontWeight="medium" foregroundStyle="secondaryLabel">
        {text}
      </Text>
      <Spacer />
      {hint ? (
        <Text font={12} foregroundStyle="tertiaryLabel">
          {hint}
        </Text>
      ) : null}
    </HStack>
  )
}

export function Chip({
  label,
  selected,
  onTap,
  disabled,
}: {
  label: string
  selected: boolean
  onTap: () => void
  disabled?: boolean
}) {
  return (
    <Button
      buttonStyle="plain"
      disabled={disabled === true}
      action={() => {
        if (disabled !== true) onTap()
      }}
    >
      <HStack
        padding={{ horizontal: 12, vertical: 7 }}
        background={
          <RoundedRectangle
            cornerRadius={RADIUS_CHIP}
            fill={selected ? CHIP_ON_BG : CHIP_BG}
          />
        }
      >
        <Text
          font={13}
          fontWeight={selected ? "semibold" : "regular"}
          foregroundStyle={
            disabled === true ? "tertiaryLabel" : selected ? CHIP_ON_FG : "label"
          }
        >
          {label}
        </Text>
      </HStack>
    </Button>
  )
}

export function SliderRow({
  title,
  value,
  min,
  max,
  step,
  display,
  onChanged,
}: {
  title: string
  value: number
  min: number
  max: number
  step: number
  display: string
  onChanged: (value: number) => void
}) {
  return (
    <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      <HStack frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text font={13} foregroundStyle="label">
          {title}
        </Text>
        <Spacer />
        <Text font={13} fontDesign="monospaced" foregroundStyle={ACCENT}>
          {display}
        </Text>
      </HStack>
      <Slider
        min={min}
        max={max}
        step={step}
        value={value}
        onChanged={onChanged}
        tint={ACCENT}
        label={<Text>{title}</Text>}
      />
    </VStack>
  )
}

export function SwitchRow({
  title,
  subtitle,
  value,
  onChanged,
  disabled,
}: {
  title: string
  subtitle?: string
  value: boolean
  onChanged: (value: boolean) => void
  disabled?: boolean
}) {
  return (
    <Toggle
      value={value}
      onChanged={onChanged}
      disabled={disabled === true}
      tint={ACCENT}
    >
      <VStack alignment="leading" spacing={1}>
        <Text
          font={13}
          foregroundStyle={disabled === true ? "tertiaryLabel" : "label"}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text font={11} foregroundStyle="tertiaryLabel">
            {subtitle}
          </Text>
        ) : null}
      </VStack>
    </Toggle>
  )
}

/** Compact key/value readout used in the account and metadata rows. */
export function StatPill({
  label,
  value,
  systemImage,
}: {
  label: string
  value: string
  systemImage?: string
}) {
  return (
    <HStack
      spacing={6}
      padding={{ horizontal: 10, vertical: 6 }}
      background={<RoundedRectangle cornerRadius={RADIUS_CHIP} fill={WELL_BG} />}
    >
      {systemImage ? (
        <Image systemName={systemImage} font={11} foregroundStyle={ACCENT} />
      ) : null}
      <Text font={11} foregroundStyle="secondaryLabel">
        {label}
      </Text>
      <Text font={11} fontWeight="semibold" fontDesign="monospaced" foregroundStyle="label">
        {value}
      </Text>
    </HStack>
  )
}

/** A tappable row that opens a menu — used for model / sampler / schedule. */
export function MenuField({
  value,
  options,
  onChanged,
}: {
  value: string
  options: { id: string; label: string; note?: string }[]
  onChanged: (id: string) => void
}) {
  const current = options.find((item) => item.id === value)
  return (
    <Menu
      label={
        <HStack
          spacing={8}
          padding={{ horizontal: 12, vertical: 10 }}
          frame={{ maxWidth: "infinity" }}
          background={<RoundedRectangle cornerRadius={RADIUS_WELL} fill={WELL_BG} />}
        >
          <Text font={14} fontWeight="medium" foregroundStyle="label">
            {current ? current.label : value}
          </Text>
          {current && current.note ? (
            <Text font={12} foregroundStyle="tertiaryLabel">
              {current.note}
            </Text>
          ) : null}
          <Spacer />
          <Image systemName="chevron.up.chevron.down" font={11} foregroundStyle={ACCENT} />
        </HStack>
      }
    >
      {options.map((item) => (
        <Button
          key={item.id}
          title={item.note ? `${item.label} · ${item.note}` : item.label}
          action={() => onChanged(item.id)}
        />
      ))}
    </Menu>
  )
}

/** Icon-only button for dense control rows. */
export function IconButton({
  systemImage,
  title,
  onTap,
  active,
  disabled,
}: {
  systemImage: string
  title: string
  onTap: () => void
  active?: boolean
  disabled?: boolean
}) {
  return (
    <Button
      buttonStyle="plain"
      disabled={disabled === true}
      action={() => {
        if (disabled !== true) onTap()
      }}
    >
      <HStack
        spacing={5}
        padding={{ horizontal: 11, vertical: 8 }}
        background={
          <RoundedRectangle
            cornerRadius={RADIUS_CHIP}
            fill={active === true ? CHIP_ON_BG : CHIP_BG}
          />
        }
      >
        <Image
          systemName={systemImage}
          font={12}
          foregroundStyle={
            disabled === true ? "tertiaryLabel" : active === true ? CHIP_ON_FG : ACCENT
          }
        />
        <Text
          font={12}
          fontWeight={active === true ? "semibold" : "regular"}
          foregroundStyle={
            disabled === true ? "tertiaryLabel" : active === true ? CHIP_ON_FG : "label"
          }
        >
          {title}
        </Text>
      </HStack>
    </Button>
  )
}

/** Full-width primary action, used for the generate button. */
export function PrimaryButton({
  title,
  systemImage,
  onTap,
  disabled,
  leading,
}: {
  title: string
  systemImage?: string
  onTap: () => void
  disabled?: boolean
  leading?: any
}) {
  return (
    <Button
      buttonStyle="plain"
      disabled={disabled === true}
      action={() => {
        if (disabled !== true) onTap()
      }}
    >
      <HStack
        spacing={8}
        padding={{ vertical: 14 }}
        frame={{ maxWidth: "infinity" }}
        background={<RoundedRectangle cornerRadius={16} fill={ACCENT_GRADIENT} />}
        opacity={disabled === true ? 0.6 : 1}
      >
        <Spacer />
        {leading}
        {systemImage && !leading ? (
          <Image systemName={systemImage} font={15} foregroundStyle="white" />
        ) : null}
        <Text font={16} fontWeight="semibold" foregroundStyle="white">
          {title}
        </Text>
        <Spacer />
      </HStack>
    </Button>
  )
}

/**
 * Opus allowance as a ring around the account avatar.
 *
 * The remaining percentage is the number an Opus subscriber actually watches,
 * and it was buried on the account page. A ring reads at a glance and costs no
 * toolbar width. The colour carries the warning: the ring goes amber and then
 * red as the allowance runs down, so it is noticeable without being read.
 */
/** Ring thickness. Also the inset, since a stroke is centred on its path. */
const RING_STROKE = 2.5

export function OpusRing({
  percent,
  initial,
  size = 28,
}: {
  /** 0-100 remaining, or null when this account has no Opus allowance. */
  percent: number | null
  /** Shown in the middle to tell accounts apart; falls back to a person glyph. */
  initial?: string
  size?: number
}) {
  const fraction =
    percent == null ? null : Math.min(1, Math.max(0, percent / 100))
  const color =
    fraction == null
      ? ACCENT
      : fraction <= 0.1
        ? ("systemRed" as any)
        : fraction <= 0.25
          ? ("systemOrange" as any)
          : ACCENT

  // A stroke straddles its path: half of it is drawn OUTSIDE the circle. A
  // circle inscribed in the frame therefore has that half clipped away where
  // it meets the edge — at twelve and six o'clock first, because a toolbar
  // pins the height and leaves the width alone.
  //
  // Insetting by exactly the line width would sit flush against the frame,
  // which antialiasing can still shave. The extra point leaves half a point of
  // margin on each side.
  const ring = Math.max(0, size - RING_STROKE - 1)

  return (
    <ZStack frame={{ width: size, height: size }}>
      {fraction == null ? null : (
        <Circle
          frame={{ width: ring, height: ring }}
          stroke={{
            shapeStyle: { color, opacity: 0.2 },
            strokeStyle: { lineWidth: RING_STROKE },
          }}
        />
      )}
      {fraction == null ? null : (
        <Circle
          frame={{ width: ring, height: ring }}
          trim={{ from: 0, to: fraction }}
          stroke={{
            shapeStyle: color,
            strokeStyle: { lineWidth: RING_STROKE, lineCap: "round" },
          }}
          // Start the arc at twelve o'clock instead of three.
          rotationEffect={-90}
        />
      )}
      {initial ? (
        <Text font={12} fontWeight="semibold" foregroundStyle={color}>
          {initial}
        </Text>
      ) : (
        <Image systemName="person.crop.circle" font={14} foregroundStyle={color} />
      )}
    </ZStack>
  )
}
