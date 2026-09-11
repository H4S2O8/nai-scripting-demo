/**
 * The 人物 tab: V4+/V5 per-character captions.
 *
 * Separate from the 人物 prompt block, which describes who is in the picture as
 * part of the base prompt. These are the structured `char_captions` the API
 * takes: one caption per character, optionally pinned to a position on the
 * canvas so the model does not have to guess who goes where.
 */
import {
  Button,
  ContentUnavailableView,
  HStack,
  Image,
  NavigationStack,
  ScrollView,
  Spacer,
  Text,
  VStack,
} from "scripting"

import { maxCharacterPrompts, modelLabel } from "./nai"
import { summarizePrompt } from "./prompttokens"
import { Workbench } from "./workbench"
import { Card, Chip, FieldLabel, SliderRow, SwitchRow, Well } from "./ui"
import { ACCENT, PAGE_BG } from "./theme"

export function CharactersTab({ wb }: { wb: Workbench }) {
  const { params } = wb
  const limit = maxCharacterPrompts(params.model)
  const characters = params.characters ?? []

  return (
    <NavigationStack>
      <ScrollView
        navigationTitle="人物"
        navigationBarTitleDisplayMode="inline"
        background={PAGE_BG}
        toolbar={{
          topBarTrailing:
            limit > 0 && characters.length < limit
              ? [<Button title="添加" systemImage="plus" action={wb.addCharacter} />]
              : [],
        }}
      >
        <VStack spacing={14} padding={{ horizontal: 14, top: 6, bottom: 20 }}>
          {limit === 0 ? (
            <Card>
              <ContentUnavailableView
                title="当前模型不支持人物 prompt"
                systemImage="person.slash"
                description={`${modelLabel(params.model)} 没有独立的角色描述字段，请换用 V4 及以上的模型。`}
              />
            </Card>
          ) : characters.length === 0 ? (
            <Card>
              <ContentUnavailableView
                title="还没有角色"
                systemImage="person.2"
                description={`${modelLabel(params.model)} 最多支持 ${limit} 个角色。右上角添加，每个角色可以单独写描述，也可以钉在画面上的某个位置。`}
              />
            </Card>
          ) : (
            characters.map((character, index) => (
              <Card
                key={String(index)}
                title={`角色 ${index + 1}`}
                systemImage="person.fill"
                trailing={
                  <HStack spacing={6}>
                    <Button
                      systemImage="arrow.up"
                      title=""
                      action={() => wb.moveCharacter(index, -1)}
                      buttonStyle="borderless"
                      controlSize="small"
                      disabled={index === 0}
                      tint={ACCENT}
                    />
                    <Button
                      systemImage="arrow.down"
                      title=""
                      action={() => wb.moveCharacter(index, 1)}
                      buttonStyle="borderless"
                      controlSize="small"
                      disabled={index === characters.length - 1}
                      tint={ACCENT}
                    />
                    <Button
                      systemImage="trash"
                      title=""
                      role="destructive"
                      action={() => wb.removeCharacter(index)}
                      buttonStyle="borderless"
                      controlSize="small"
                    />
                  </HStack>
                }
              >
                <FieldLabel text="描述" hint={character.prompt.trim() ? undefined : "必填"} />
                <Well padding={9}>
                  <Text
                    font={13}
                    foregroundStyle={character.prompt.trim() ? "label" : "tertiaryLabel"}
                    lineLimit={3}
                    onTapGesture={() => wb.editPrompt({ kind: "char", index, field: "prompt" })}
                  >
                    {summarizePrompt(character.prompt) || "点这里编辑"}
                  </Text>
                </Well>

                <FieldLabel text="角色负面词" />
                <Well padding={9}>
                  <Text
                    font={13}
                    foregroundStyle={character.negative.trim() ? "label" : "tertiaryLabel"}
                    lineLimit={2}
                    onTapGesture={() => wb.editPrompt({ kind: "char", index, field: "negative" })}
                  >
                    {summarizePrompt(character.negative) || "（可留空）"}
                  </Text>
                </Well>

                <SwitchRow
                  title="指定位置"
                  subtitle="关闭时由模型自行安排（协议里的 0.5, 0.5）"
                  value={character.useCoords}
                  onChanged={(value) => wb.patchCharacter(index, { useCoords: value })}
                />
                {character.useCoords ? (
                  <VStack
                    alignment="leading"
                    spacing={10}
                    frame={{ maxWidth: "infinity", alignment: "leading" }}
                  >
                    <SliderRow
                      title="水平"
                      value={character.x}
                      min={0}
                      max={1}
                      step={0.05}
                      display={character.x.toFixed(2)}
                      onChanged={(value) =>
                        wb.patchCharacter(index, { x: Math.round(value * 20) / 20 })
                      }
                    />
                    <SliderRow
                      title="垂直"
                      value={character.y}
                      min={0}
                      max={1}
                      step={0.05}
                      display={character.y.toFixed(2)}
                      onChanged={(value) =>
                        wb.patchCharacter(index, { y: Math.round(value * 20) / 20 })
                      }
                    />
                    <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                      <Chip
                        label="左"
                        selected={character.x < 0.35}
                        onTap={() => wb.patchCharacter(index, { x: 0.25, y: 0.5 })}
                      />
                      <Chip
                        label="中"
                        selected={character.x >= 0.35 && character.x <= 0.65}
                        onTap={() => wb.patchCharacter(index, { x: 0.5, y: 0.5 })}
                      />
                      <Chip
                        label="右"
                        selected={character.x > 0.65}
                        onTap={() => wb.patchCharacter(index, { x: 0.75, y: 0.5 })}
                      />
                      <Spacer />
                    </HStack>
                  </VStack>
                ) : null}
              </Card>
            ))
          )}

          {limit > 0 ? (
            <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Image systemName="info.circle" font={11} foregroundStyle="tertiaryLabel" />
              <Text font={11} foregroundStyle="tertiaryLabel">
                {modelLabel(params.model)} 最多 {limit} 个 · 描述为空的角色不会发送
              </Text>
              <Spacer />
            </HStack>
          ) : null}
        </VStack>
      </ScrollView>
    </NavigationStack>
  )
}
