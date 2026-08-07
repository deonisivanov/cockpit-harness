Я хочу с нуля спроектировать и затем реализовать новый локальный продукт Cockpit по мотивам Cockpit Ильи Климова. Приложенные скриншоты являются главным функциональным и визуальным референсом.

Сейчас не пиши код. Сначала запусти OMC Deep Interview и подробно проработай со мной продукт, архитектуру, execution model, plugin model, retry model, session model, developer experience и UI.

Отвечай мне на русском. Весь код, UI-текст, документация, комментарии, имена файлов и программных сущностей будущего проекта должны быть на английском.

Реализацию можно начинать только после моего явного одобрения итогового плана.

## Основная концепция

Cockpit — локальная система, которая получает написанный пользователем prompt, анализирует задачу, составляет workflow, выполняет его через Claude Code и/или Codex, проверяет результат и показывает весь процесс в control-room UI.

Архитектура должна состоять из двух частей:

1. Reusable Cockpit Core — универсальный engine, отвечающий за workflows, blocks, plugin execution, persistence, retries, recovery, isolation, observability и UI. Core ничего не должен знать о конкретном проекте и его технологиях.

2. Project cartridge — TypeScript-конфигурация внутри `<project>/.cockpit/`, описывающая особенности проекта: blocks, prompts, commands, plugins, workflow transforms, retry policies, validators, environment setup, project rules, widgets и другие расширения.

Чтобы подключить новый проект, пользователь добавляет в него `.cockpit/`, описывает конфигурацию и необходимые blocks на TypeScript, после чего универсальный Cockpit Core может работать с этим проектом.

## Ограничения

- Пользователь сам вводит prompt в Cockpit.
- Jira, GitLab и другие task sources сейчас не требуются.
- Создание pull request или merge request не требуется.
- Продукт полностью локальный и single-user.
- Главный приоритет — лучший возможный developer experience.
- Не нужно проектировать enterprise multi-tenancy и избыточную инфраструктуру.
- Нельзя жертвовать сохранностью работы, изоляцией процессов, корректным восстановлением и понятностью состояния системы.
- AI должен запускаться через установленные и авторизованные Claude Code и Codex CLI с обычной подпиской пользователя.
- Не использовать API-ключи, LiteLLM, прямые model API или отдельный billing proxy.
- Это полностью новая реализация. Не ищи и не используй какие-либо существующие реализации Cockpit на диске.

## Workflow model

Для каждой задачи Analyzer должен создавать отдельное workflow tree:

- какие blocks необходимы;
- в каком порядке они выполняются;
- какие blocks можно выполнять параллельно;
- какие существуют conditions;
- какие нужны loops и retries;
- какое максимальное количество попыток разрешено в каждом месте;
- где необходимы human approval gates;
- какие проверки определяют успешность результата;
- какой AI provider, plugin, skill, agent или orchestration mode лучше использовать для каждого block.

После Analyzer детерминированные TypeScript transforms из project cartridge должны добавлять обязательные правила проекта и изменять workflow tree.

Затем validator должен проверить дерево до запуска:

- существование blocks;
- корректность связей;
- inputs и outputs;
- conditions;
- loops;
- retry limits;
- resource limits;
- human gates;
- доступность требуемых plugins и capabilities;
- отсутствие недопустимых циклов;
- наличие условий завершения.

LLM предлагает workflow, но детерминированный код гарантирует обязательные правила и валидность.

## Blocks

Нужно поддерживать как минимум два основных вида blocks:

- Agent blocks — полноценный запуск Claude Code или Codex с инструментами, доступом к разрешенному workspace и собственной задачей.
- Command blocks — выполнение конкретной shell-команды без AI с оценкой результата по exit code и дополнительным правилам.

Примеры возможных blocks:

- explore;
- reproduce;
- plan;
- fixture;
- visual-before;
- implement;
- plan-conformance;
- verify;
- predictive-verify;
- visual-after;
- review;
- apply-review-fixes;
- comment-lint;
- finalize;
- retrospective.

Это только примеры, а не фиксированный список. Я пока не знаю окончательный состав workflow blocks.

Project cartridge должен иметь возможность определять собственные:

- blocks;
- workflows;
- prompts;
- commands;
- plugins;
- agents;
- orchestration modes;
- loops;
- conditions;
- retry policies;
- validators;
- input/output contracts.

Для каждого agent block обычно должна запускаться чистая изолированная Claude Code или Codex session. Независимая проверка не должна случайно наследовать рассуждения implementer-сессии.

Между blocks необходим явный типизированный context handoff:

- исходная задача;
- план;
- решения;
- artifacts;
- измененные файлы;
- commits и checkpoints;
- результаты команд;
- verification evidence;
- ошибки;
- результаты предыдущих попыток;
- другие необходимые данные.

Не используй `resume` автоматически. Во время Deep Interview отдельно определи, где нужна новая независимая session, где допустимо продолжение существующей session и как избежать скрытого или неполного контекста.

## Plugin-aware execution и OMC

Для большинства agent workflow blocks я хочу иметь возможность использовать OMC или другой установленный Claude Code/Codex plugin.

Например, в зависимости от задачи и доступных capabilities:

- обычное планирование может использовать OMC Plan;
- сложное согласованное планирование может использовать OMC RALPlan;
- review может использовать OMC code reviewer или соответствующего специализированного agent;
- исследование может использовать OMC explore;
- реализация может использовать подходящий OMC execution workflow;
- verification может использовать отдельный verifier;
- другие blocks могут использовать другие plugins, skills, commands или agents.

Это примеры, а не окончательный список. Не фиксируй архитектуру вокруг текущих названий blocks или конкретного набора OMC-команд.

Cockpit должен поддерживать plugin-aware block definition. Для каждого agent block должно быть возможно определить:

- provider: Claude Code или Codex;
- plugin, если он нужен;
- plugin command, skill, agent или orchestration mode;
- аргументы и дополнительные instructions;
- required capabilities;
- input schema;
- output schema;
- session policy;
- retry policy;
- timeout;
- permissions;
- workspace access;
- expected artifacts;
- success criteria;
- fallback behavior.

Plugin integration должна быть data-driven и расширяемой через project cartridge. Нельзя жестко зашивать все OMC-команды непосредственно в Cockpit Core.

При этом не нужно заранее создавать сложную универсальную plugin platform, если более простой типизированный контракт покрывает требования. Найди минимальную архитектуру, которая действительно позволяет подключать разные plugins и workflows без изменения Core.

Cockpit должен уметь запускать plugin workflow внутри настоящей нативной Claude Code или Codex session с использованием существующей подписки пользователя.

Нужно учитывать, что plugin может:

- изменять system behavior сессии;
- запускать собственных subagents;
- создавать внутренние планы;
- иметь собственные retry loops;
- требовать human input;
- писать собственные state files;
- завершаться частично;
- иметь собственные правила cancellation;
- возвращать не полностью структурированный transcript.

Cockpit должен сохранять понятную границу ответственности между:

- workflow orchestration самого Cockpit;
- внутренней orchestration выбранного plugin;
- provider-native session;
- project cartridge.

Не нужно дублировать внутри Cockpit то, что качественно делает OMC или другой plugin. При этом Cockpit должен оставаться владельцем внешнего workflow, состояния task, checkpoints, attempt history, cancellation и recovery.

Перед запуском block нужен preflight:

- установлен ли требуемый plugin;
- доступен ли provider;
- авторизован ли Claude Code или Codex;
- существует ли требуемая command/skill/agent;
- совместима ли версия;
- доступны ли необходимые permissions;
- можно ли безопасно запустить block в выбранном workspace.

Если capability отсутствует, Cockpit должен показать понятную ошибку или предложить согласованный fallback. Нельзя молча подменять выбранный workflow другим поведением.

Точные названия OMC-команд, slash commands, skills, agents и способы их запуска не нужно угадывать. Во время Deep Interview проверь фактически установленную версию OMC и доступные capabilities, после чего спроектируй корректную интеграцию.

Также проработай:

- как Analyzer выбирает plugin для block;
- что выбирает Analyzer, а что жестко задает cartridge;
- как transforms могут принудительно заменить или добавить plugin workflow;
- как сохранять plugin version вместе с run;
- как отображать plugin и agent в UI;
- как захватывать события plugin и его subagents;
- как обрабатывать plugin question/human input;
- как останавливать plugin и все дочерние процессы;
- как восстанавливать block после падения;
- как избежать двойных retries, если retry есть и в Cockpit, и внутри plugin;
- можно ли менять plugin или provider между попытками;
- как fallback влияет на воспроизводимость результата.

## Adaptive retries и базовое самообучение

Это одна из ключевых частей системы.

Результат каждой проваленной попытки должен становиться входом следующей попытки. Следующая попытка должна понимать:

- что пыталась сделать предыдущая;
- какую гипотезу она проверяла;
- какой plugin, agent или orchestration mode использовала;
- какие изменения внесла;
- какие команды запускала;
- что именно не сработало;
- какие tests или validators упали;
- какие ошибки и diagnostics были получены;
- какие artifacts были созданы;
- почему попытка признана неуспешной;
- что уже не нужно повторять;
- какие возможные направления остаются.

Таким образом внутри одного run реализуется примитивное базовое самообучение: каждая следующая попытка использует evidence предыдущих попыток и корректирует стратегию.

Это не обучение модели и не изменение ее весов. Это bounded within-run learning через структурированный feedback loop.

Следующая попытка не должна просто повторять тот же prompt. Она должна получить:

- исходную цель block;
- актуальное состояние workspace;
- block contract;
- verification criteria;
- компактный failure feedback предыдущих попыток;
- информацию об использованных plugins и стратегиях;
- явное требование изменить стратегию с учетом полученных evidence.

Нужно определить типизированный `AttemptResult` или аналогичный контракт. Он должен содержать достаточно информации для следующей попытки, но не передавать весь сырой transcript без необходимости.

Для предотвращения переполнения контекста используй точечный retry context:

- последняя попытка может передаваться подробнее;
- более старые попытки должны сворачиваться в краткие структурированные summaries;
- повторяющиеся ошибки должны дедуплицироваться;
- длинные stdout/stderr должны храниться как artifacts и передаваться ссылками или релевантными excerpts;
- большие diffs должны передаваться через состояние workspace и ссылки на checkpoints;
- несущественные рассуждения и шум не должны попадать в следующую попытку;
- каждая попытка должна видеть только контекст, необходимый конкретному block;
- размер retry context должен быть ограничен и контролируем.

Для разных blocks и loops должно поддерживаться разное количество попыток. Например:

- reproduce может иметь один retry policy;
- implement/verify loop — другой;
- visual-after — другой;
- review fixes — другой;
- command block — отдельную политику;
- plugin workflow — собственную политику;
- project cartridge может переопределять limits и условия остановки.

Retry policy должна поддерживать как минимум:

- maximum attempts;
- timeout per attempt;
- overall loop timeout;
- retryable и non-retryable errors;
- backoff для технических ошибок;
- условия успешности;
- условия немедленной остановки;
- human approval после определенного количества неудач;
- no-progress detection;
- detection повторяющейся одинаковой ошибки;
- возможность сменить Claude Code на Codex или наоборот, если это будет согласовано;
- возможность сменить plugin или execution strategy;
- сохранение checkpoint каждой meaningful попытки;
- rollback или продолжение от текущего workspace в зависимости от типа loop.

Нужно различать:

- technical retry — процесс упал, оборвалось соединение или произошла временная инфраструктурная ошибка;
- semantic retry — agent завершил работу, но verification criteria не выполнены;
- corrective loop — verifier передает конкретные замечания implementer-блоку;
- plugin-internal retry — повторная попытка управляется самим plugin;
- Cockpit-level retry — повторная попытка управляется workflow engine;
- human-directed retry — пользователь добавляет уточнение или review feedback.

Во время Deep Interview отдельно реши:

- должна ли следующая попытка продолжать provider-native session или запускаться в новой session с failure packet;
- когда сохранять изменения предыдущей попытки;
- когда делать rollback;
- как определять отсутствие прогресса;
- как избежать бесконечных loops;
- как формировать компактный failure summary;
- как передавать verifier feedback implementer-блоку;
- как координировать Cockpit retry и plugin retry;
- как отображать attempts и накопленный evidence в UI.

Каждая попытка и ее feedback должны сохраняться durable и быть доступны для просмотра.

Retry learning внутри одной задачи нужно отличать от retrospective learning между разными runs.

## Effect for TypeScript

Effect является обязательной архитектурной основой для Cockpit Core, backend logic, execution runtime и project cartridge APIs.

Система должна быть Effect-native, а не обычным Promise-based приложением, поверх которого местами вызывается `Effect.runPromise`.

Используй Effect для:

- workflow orchestration;
- plugin execution;
- Claude Code и Codex process management;
- typed errors;
- services and dependency injection;
- Layer and Config;
- Schema validation and serialization;
- structured concurrency;
- cancellation and interruption;
- resource lifecycle and Scope;
- retries and Schedule;
- streams;
- queues and pub/sub;
- persistence operations;
- logging, tracing and observability;
- filesystem and terminal integrations;
- sandbox management;
- typed block inputs and outputs;
- context handoff;
- attempt feedback;
- retry policies;
- recovery after failures.

Project cartridges в `.cockpit/` также должны использовать типизированные Effect APIs и Schema-контракты.

Во время Deep Interview отдельно проработай:

- структуру Effect services и Layers;
- ownership Effect runtime;
- управление жизненным циклом дочерних CLI и plugin-процессов;
- cancellation и гарантированный cleanup;
- typed workflow events;
- typed attempt events;
- persistence и восстановление после перезапуска;
- тестирование Effect-based runtime;
- зрелость подходящих пакетов экосистемы Effect.

Effect — обязательное архитектурное решение. Не предлагай отказаться от него только ради упрощения.

## Isolation, checkpoints and recovery

Нужно проработать:

- изолированный workspace или sandbox для задачи;
- воспроизводимое начальное состояние;
- reconcile перед выполнением;
- точную фиксацию base commit;
- health checks перед запуском;
- безопасную передачу изменений между blocks;
- checkpoint после каждого успешно завершенного meaningful block;
- checkpoints неуспешных попыток, если они содержат полезные изменения;
- возможность восстановить состояние конкретного шага;
- retry отдельного block;
- rollback отдельной попытки;
- продолжение workflow с последнего подтвержденного шага;
- устойчивость к закрытию приложения;
- устойчивость к падению worker;
- устойчивость к принудительному завершению процесса;
- отсутствие повторного выполнения уже надежно завершенных side effects;
- finalize, превращающий промежуточные checkpoints в чистый итоговый результат.

Во время интервью определи, нужен ли Temporal, собственный durable journal, Effect-based workflow runtime или другая модель. Выбор должен основываться на надежности, локальном DX и реальных требованиях, а не на желании скопировать конкретную технологию.

Также оцени архитектуру, при которой coordinator и executor могут работать как на одной машине, так и раздельно. Удаленный executor не является обязательным заранее — необходимость и границы этой возможности нужно определить в интервью.

## Session continuity и продолжение в терминале

Это критически важная функция.

Для каждой задачи в Cockpit должна быть одна очевидная кнопка `Open session in terminal`. Она должна быть доступна:

- во время выполнения;
- после успешного завершения;
- после ошибки;
- после отмены;
- после исчерпания retries;
- при появлении новых вопросов;
- при появлении review feedback.

После нажатия Cockpit должен открыть Ghostty в используемом мной окружении Herd и запустить соответствующую нативную Claude Code или Codex session через CLI. Не нужно открывать отдельное GUI-приложение Claude.

Я должен сразу иметь возможность написать дополнительный вопрос или попросить изменения. Открытая session должна понимать:

- исходный prompt;
- проанализированный контекст проекта;
- утвержденный план;
- выполненные workflow blocks;
- использованные plugins и agents;
- все meaningful attempts;
- причины неудачных попыток;
- принятые решения;
- измененные файлы;
- checkpoints и commits;
- результаты тестов и проверок;
- ошибки и retries;
- artifacts;
- review feedback;
- итоговый результат.

Хотя отдельные blocks и attempts могут выполняться в разных изолированных sessions, для пользователя продолжение должно выглядеть как одна полноценная task-level session.

По возможности необходимо возобновлять настоящую provider-native Claude Code или Codex session по сохраненному session ID, а не создавать визуальную имитацию истории.

Во время Deep Interview спроектируй надежную модель этого поведения. Рассмотри canonical continuation/integrator session, явную сборку task context и другие варианты. Пользователь не должен вручную выбирать одну из множества технических block, plugin или attempt sessions.

Обязательно уточни у меня:

- точное название и устройство окружения Herd;
- команду запуска Ghostty;
- команду запуска Claude Code и Codex;
- способ resume provider-native session;
- нужный working directory;
- поведение кнопки, если session больше нельзя возобновить;
- возможность открыть новую terminal session на основе сохраненного task context.

## Observability и UI

UI должен максимально близко следовать приложенным референсам Cockpit Ильи Климова.

Основной layout:

- слева — список проектов и задач;
- по центру — live execution stream выбранной задачи, block или attempt;
- справа — workflow tree.

Левая панель должна показывать:

- проекты;
- задачи;
- текущие состояния;
- короткие названия;
- successful runs;
- running runs;
- waiting runs;
- cancelled runs;
- failed runs;
- быстрый переход к предыдущим задачам.

Центральная панель должна показывать структурированные значимые события:

- Session;
- Agent;
- Plugin;
- Prompt;
- Command/Bash;
- Result;
- Question;
- Error;
- Artifact;
- Checkpoint;
- Approval;
- Attempt;
- Retry;
- Verification;
- Failure feedback.

Основной экран не должен превращаться в нечитабельный сырой terminal log. По умолчанию нужно показывать главное в компактном структурированном виде, но позволять раскрыть:

- полный prompt;
- полный transcript;
- raw stdout/stderr;
- command details;
- plugin details;
- subagent details;
- stack traces;
- structured metadata;
- generated artifacts;
- attempt input;
- attempt result;
- failure summary;
- feedback, переданный следующей попытке.

Нужны качественное отображение ANSI output, кода, diffs, длинных строк, shell-команд, результатов, Markdown и streaming text.

Правая панель должна показывать:

- workflow tree;
- blocks и их типы;
- используемый plugin или agent;
- loops;
- текущий номер попытки;
- maximum attempts;
- conditions;
- retries;
- skipped blocks;
- текущий выполняющийся block;
- duration;
- status;
- зависимости;
- human gates;
- результат каждой попытки.

Визуально loops должны быть понятны примерно как в референсе: `2/3`, `1/4` и аналогичные indicators. Должно быть сразу видно, какая попытка выполняется, какая завершилась неудачно и какой feedback был передан дальше.

Пользователь должен иметь возможность выбрать любой block или attempt и увидеть:

- session;
- plugin;
- agent;
- события;
- inputs;
- outputs;
- artifacts;
- transcript;
- verification result;
- failure reason;
- retry context.

Нужны live streaming, понятные loading states, retry/recovery controls, approval screens, keyboard shortcuts и удобная навигация.

Это локальный инструмент для одного разработчика, поэтому при выборе UI-библиотек, terminal rendering, code highlighting, diff rendering и desktop integrations приоритетом должен быть лучший DX и качество интерфейса.

Визуальное направление:

- dark control-room interface;
- близкая к референсу плотность;
- похожая типографика;
- аккуратная моноширинная часть;
- тонкие границы;
- спокойные status colors;
- хорошая визуальная иерархия;
- минимум декоративного шума;
- максимальная читаемость длительных runs.

Не нужно слепо копировать каждый пиксель, но результат должен ощущаться как качественная реализация той же продуктовой идеи, а не как упрощенный generic dashboard.

## Retrospective и learning loop

После каждого run retrospective должен анализировать:

- transcripts;
- plugins и agents;
- attempts;
- retries;
- failures;
- dead ends;
- no-progress loops;
- медленные blocks;
- бесполезные действия;
- повторяющиеся проблемы;
- недостаточный context handoff;
- слишком большой retry context;
- потерю полезного feedback;
- неэффективные prompts;
- неудачный выбор plugin;
- проблемы Core;
- проблемы project cartridge.

Результатом должны быть конкретные предложения по улучшению, разделенные как минимум на:

- Cockpit Core improvements;
- project cartridge improvements.

Повторяющиеся предложения нужно дедуплицировать и усиливать дополнительными evidence, а не создавать бесконечные копии.

Нужно различать два уровня learning:

1. Within-run learning — следующая попытка использует structured failure feedback предыдущих попыток в рамках текущей задачи.

2. Cross-run learning — retrospective находит повторяющиеся проблемы между разными задачами и предлагает изменения Core или project cartridge.

Сначала спроектируй формат локального хранения и просмотра этих предложений. Автоматическое создание внешних issues не требуется.

## Ожидаемый результат Deep Interview

В ходе интервью нужно согласовать:

- product boundaries;
- Core/cartridge architecture;
- Effect architecture;
- workflow schema;
- block contract;
- plugin execution contract;
- OMC integration;
- attempt contract;
- retry policy contract;
- context handoff;
- adaptive retry model;
- failure feedback format;
- context compaction;
- analyzer and transforms;
- validator;
- session isolation;
- task-level continuation session;
- Ghostty/Herd integration;
- persistence;
- checkpoints;
- rollback strategy;
- durable recovery;
- sandbox strategy;
- event model;
- frontend/backend communication;
- UI information architecture;
- technology stack;
- testing strategy;
- implementation phases;
- acceptance criteria;
- основные риски и неизвестные.

Не принимай важные решения молча. Показывай варианты, trade-offs и свою рекомендацию, после чего фиксируй согласованное решение.

## Документы после интервью

После завершения Deep Interview и согласования решений создай в корне проекта папку `docs/`.

Как минимум создай следующие документы.

### `docs/cockpit-plan.md`

Полный согласованный product, architecture and implementation plan, включая:

- Core и cartridge;
- Effect architecture;
- workflow model;
- blocks;
- plugin-aware execution;
- OMC integration;
- attempts and retries;
- within-run learning;
- failure feedback;
- context compaction;
- session model;
- context handoff;
- terminal continuation;
- Ghostty/Herd integration;
- persistence and recovery;
- isolation;
- checkpoints and rollback;
- event model;
- UI architecture;
- implementation phases;
- testing;
- acceptance criteria.

### `docs/claude-design-prompt.md`

Самостоятельный prompt для Claude Design, основанный на приложенных UI-референсах. Он должен подробно описывать:

- visual direction;
- layout;
- typography;
- colors;
- spacing and density;
- left task rail;
- central execution stream;
- right workflow tree;
- blocks and loops;
- plugin and agent indicators;
- attempt counters;
- retry states;
- failure feedback;
- transcripts;
- terminal output;
- interactions;
- approval screens;
- session continuation controls;
- responsive behavior;
- component states.

Claude Design должен ориентироваться на интерфейс Ильи Климова, включая похожее ощущение от шрифтов, плотности и control-room presentation.

При необходимости создай дополнительные документы для:

- ADR;
- workflow schema;
- block contracts;
- plugin contracts;
- attempt contracts;
- retry policies;
- event model;
- session continuity;
- persistence model.

Не начинай реализацию, пока я явно не одобрю итоговый план.

## Критически важное требование: не соглашайся со мной автоматически

Все, что написано в этом prompt, ты имеешь право и обязан критически анализировать.

Не воспринимай мои предположения как уже принятые архитектурные решения. Если требование противоречиво, технически невозможно, избыточно, опасно, ухудшает DX или имеет более сильную альтернативу — скажи об этом прямо.

Ты должен:

- обдумывать каждое существенное требование;
- задавать вопросы до принятия важных решений;
- указывать на противоречия и скрытые последствия;
- проверять мои технические предположения;
- объяснять, с чем ты согласен, а с чем не согласен;
- предлагать собственные идеи и лучшие альтернативы;
- показывать trade-offs;
- отделять обязательные продуктовые требования от моих предварительных технических гипотез;
- не скрывать несогласие ради того, чтобы быстрее перейти к реализации;
- не начинать разработку, пока ключевые неизвестные не разрешены.

Мне нужен не исполнитель, который механически подтверждает мои идеи, а сильный технический партнер, способный спорить, критиковать, предлагать лучшее решение и помогать принять обоснованные решения.
