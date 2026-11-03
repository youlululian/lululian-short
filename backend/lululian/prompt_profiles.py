"""Editable project instructions, separate from fixed API contracts and tool permissions."""

from pydantic import BaseModel, ConfigDict, Field


class PipelinePrompts(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    script: str = Field(
        default="每集 4 至 8 个镜头，每镜 4 至 12 秒，对白长度符合镜头时长。开场呈现可见冲突，角色采取行动并付出代价，结尾出现新信息或选择。保持角色外貌、服装和道具连续，分镜写清构图、光线与动作。",
        min_length=1,
        max_length=4000,
    )
    script_judge: str = Field(
        default="重点评审开场冲突、角色行为动机、情节连续性、镜头可执行性、对白时长和结尾悬念，提出具体可执行的修改建议。",
        min_length=1,
        max_length=4000,
    )
    image: str = Field(
        default="忠实呈现分镜要求，保持角色造型和场景风格一致，画面清晰，避免多余文字和水印。",
        min_length=1,
        max_length=4000,
    )
    video: str = Field(
        default="忠实呈现已确认分镜，保持人物外貌、服装和场景一致；动作顺序清楚，镜头衔接自然，不擅自增加剧情或角色。",
        min_length=1,
        max_length=4000,
    )
    video_judge: str = Field(
        default="检查动作符合度、人物外观、场景、时序连续性和明显视觉缺陷。逐项指出问题出现的时间、可观察证据及改进建议。",
        min_length=1,
        max_length=4000,
    )
    feedback_summary: str = Field(
        default="从人工通过样本总结需要保留的特征，从不通过样本总结反复出现的问题，形成下一轮可执行的优化规则；矛盾反馈需要明确指出。",
        min_length=1,
        max_length=4000,
    )
    prompt_tune: str = Field(
        default="结合人工修改和通过／不通过标注总结，优化构图、动作顺序、时长安排和生成约束。优先修复明确问题，保留已经满意的特征。",
        min_length=1,
        max_length=4000,
    )
    video_repair: str = Field(
        default="根据视频 Judge 提供的具体证据修订提示词。优先修复阻断问题，只调整可见动作、构图、时序和生成约束，避免无关改动。",
        min_length=1,
        max_length=4000,
    )


def compose_prompt(contract: str, instructions: str) -> str:
    # Instructions are plain model input. No template evaluation or executable hooks.
    return f"用户制作要求：\n{instructions}\n\n固定输出与权限约束：\n{contract}"
