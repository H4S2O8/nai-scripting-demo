/**
 * Shared presentation pieces for the workbench.
 *
 * Layout convention throughout: a stack carries `padding` plus a
 * `background={<RoundedRectangle .../>}`. That is the combination the platform
 * documents; a stray modifier on the shape itself silently does nothing.
 */
import {
  Button,
  HStack,
  Image,
  RoundedRectangle,
  Slider,
  Spacer,
  Text,
  Toggle,
  VStack,
} from "scripting"

import {
  ACCENT,
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
