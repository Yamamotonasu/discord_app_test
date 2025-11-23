import { GatewayIntentBits, Client, Partials, Message, ActionRowBuilder, UserSelectMenuBuilder, UserSelectMenuInteraction, ComponentType, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import * as cron from 'node-cron';

// .envファイルを読み込む
dotenv.config();

// Supabaseクライアントの初期化
const supabaseUrl = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const supabaseKey = process.env.SUPABASE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

// リマインダー登録中の一時データを保存（ユーザーID -> リマインダー情報）
const pendingReminders = new Map<string, {
    scheduledAtJST: Date;
    scheduledAtUTC: Date;
    message: string;
    channelId: string;
}>();

// Botで使うGatewayIntents、partials
const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// Botがきちんと起動したか確認
client.once('ready', () => {
    console.log('Ready!');
    if(client.user){
        console.log(client.user.tag);
    }

    // 毎分リマインダーをチェックするcronジョブ
    cron.schedule('* * * * *', async () => {
        const now = new Date();
        const nowUTC = now.toISOString();
        const nowJST = now.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
        console.log(`[UTC: ${nowUTC}] [JST: ${nowJST}] リマインダーチェック実行中...`);
        
        // 現在時刻を過ぎた未通知のリマインダーを取得
        const { data, error } = await supabase
            .from('reminders')
            .select('*')
            .eq('notified', false)
            .lte('scheduled_at', nowUTC);

        if (error) {
            console.error('Error fetching reminders:', error);
            return;
        }

        console.log(`取得したリマインダー数: ${data?.length || 0}`);

        if (!data || data.length === 0) {
            return;
        }

        // 各リマインダーを通知
        for (const reminder of data) {
            try {
                const scheduledJST = new Date(reminder.scheduled_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
                console.log(`リマインダー処理中: ID=${reminder.id}, scheduled_at(UTC)=${reminder.scheduled_at}, scheduled_at(JST)=${scheduledJST}, channel_id=${reminder.channel_id}`);
                const channel = await client.channels.fetch(reminder.channel_id);
                
                if (!channel) {
                    console.error(`チャンネルが見つかりません: ${reminder.channel_id}`);
                    continue;
                }

                if ('send' in channel) {
                    // メンション文字列を作成
                    const mentions = reminder.mention_user_ids && reminder.mention_user_ids.length > 0
                        ? reminder.mention_user_ids.map((id: string) => `<@${id}>`).join(' ')
                        : '';
                    
                    const messageContent = mentions
                        ? `🔔 リマインダー: ${reminder.message}\n${mentions}`
                        : `🔔 リマインダー: ${reminder.message}`;
                    
                    await channel.send(messageContent);
                    console.log(`リマインダー送信成功: ID=${reminder.id}, メンション数=${reminder.mention_user_ids?.length || 0}`);
                } else {
                    console.error(`チャンネルがテキストチャンネルではありません: ${reminder.channel_id}`);
                    continue;
                }

                // 通知済みフラグを更新
                const { error: updateError } = await supabase
                    .from('reminders')
                    .update({ notified: true })
                    .eq('id', reminder.id);

                if (updateError) {
                    console.error(`通知済みフラグ更新エラー: ID=${reminder.id}`, updateError);
                } else {
                    console.log(`通知済みフラグ更新成功: ID=${reminder.id}`);
                }
            } catch (error) {
                console.error(`Error sending reminder ${reminder.id}:`, error);
            }
        }
    });

    console.log('リマインダーチェックが開始されました（毎分実行）');
});

// !timeと入力すると現在時刻を返信するように
client.on('messageCreate', async (message: Message) => {
    if (message.author.bot) return;
    if (message.content === '/time') {
        const date1 = new Date();
        if ('send' in message.channel) {
            message.channel.send(date1.toLocaleString());
        }
    }

    // !remindコマンド: カレンダーUIで日時を選択
    if (message.content === '!remind' || message.content.startsWith('!remind ')) {
        // メッセージが含まれている場合は従来の方法もサポート
        if (message.content.startsWith('!remind ') && message.content.length > 8) {
            const args = message.content.slice(8).trim();
            const parts = args.split(' ');
            
            if (parts.length >= 3) {
                // 従来のテキスト入力方式
                const dateStr = parts[0];
                const timeStr = parts[1];
                const reminderMessage = parts.slice(2).join(' ');
                
                try {
                    const [year, month, day] = dateStr.split('/').map(Number);
                    const [hour, minute] = timeStr.split(':').map(Number);
                    const scheduledAtJST = new Date(year, month - 1, day, hour, minute);
                    const scheduledAtUTC = new Date(scheduledAtJST.getTime() - 9 * 60 * 60 * 1000);
                    
                    const nowJST = new Date();
                    if (scheduledAtJST <= nowJST) {
                        if ('send' in message.channel) {
                            message.channel.send('エラー: 過去の日時は指定できません。');
                        }
                        return;
                    }
                    
                    pendingReminders.set(message.author.id, {
                        scheduledAtJST,
                        scheduledAtUTC,
                        message: reminderMessage,
                        channelId: message.channel.id,
                    });
                    
                    await showMentionSelectMenu(message, scheduledAtJST, reminderMessage);
                    return;
                } catch (error) {
                    console.error('Error parsing date:', error);
                }
            }
        }
        
        // Modalフォームで日時を入力
        if (!message.guild) {
            if ('send' in message.channel) {
                message.channel.send('エラー: サーバー内でのみ使用できます。');
            }
            return;
        }
        
        // 日時入力用のModalを作成
        const modal = new ModalBuilder()
            .setCustomId('remind_date_time_modal')
            .setTitle('リマインダー登録');
        
        const dateInput = new TextInputBuilder()
            .setCustomId('remind_date')
            .setLabel('日付 (YYYY/MM/DD)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('例: 2023/11/24')
            .setRequired(true);
        
        const timeInput = new TextInputBuilder()
            .setCustomId('remind_time')
            .setLabel('時刻 (HH:mm)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('例: 15:00')
            .setRequired(true);
        
        const messageInput = new TextInputBuilder()
            .setCustomId('remind_message')
            .setLabel('リマインダーメッセージ')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('例: 会議の時間です')
            .setRequired(true);
        
        const dateRow = new ActionRowBuilder<TextInputBuilder>().addComponents(dateInput);
        const timeRow = new ActionRowBuilder<TextInputBuilder>().addComponents(timeInput);
        const messageRow = new ActionRowBuilder<TextInputBuilder>().addComponents(messageInput);
        
        modal.addComponents(dateRow, timeRow, messageRow);
        
        // Modalを表示するにはInteractionが必要なので、ボタンで実装
        const button = new ButtonBuilder()
            .setCustomId('remind_open_modal')
            .setLabel('📅 日時を選択')
            .setStyle(ButtonStyle.Primary);
        
        const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(button);
        
        if ('send' in message.channel) {
            await message.channel.send({
                content: '📅 **リマインダー登録**\n\n日時を選択するボタンを押してください:',
                components: [buttonRow],
            });
        }
    }

    // !listコマンド: 自分のリマインダー一覧を表示
    if (message.content === '!list') {
        const { data, error } = await supabase
            .from('reminders')
            .select('*')
            .eq('user_id', message.author.id)
            .eq('notified', false)
            .order('scheduled_at', { ascending: true });

        if (error) {
            console.error('Error fetching reminders:', error);
            if ('send' in message.channel) {
                message.channel.send('エラー: リマインダーの取得に失敗しました。');
            }
            return;
        }

        if (!data || data.length === 0) {
            if ('send' in message.channel) {
                message.channel.send('登録されているリマインダーはありません。');
            }
            return;
        }

        const reminderList = data.map((r, index) => {
            const date = new Date(r.scheduled_at);
            return `${index + 1}. ${date.toLocaleString('ja-JP')} - ${r.message}`;
        }).join('\n');

        if ('send' in message.channel) {
            message.channel.send(`📋 あなたのリマインダー一覧:\n${reminderList}`);
        }
    }
});

// User Select Menuとボタンの選択を処理
client.on('interactionCreate', async (interaction) => {
    // Modalを開くボタンの処理
    if (interaction.isButton() && interaction.customId === 'remind_open_modal') {
        const modal = new ModalBuilder()
            .setCustomId('remind_date_time_modal')
            .setTitle('リマインダー登録');
        
        const dateInput = new TextInputBuilder()
            .setCustomId('remind_date')
            .setLabel('日付 (YYYY/MM/DD)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('例: 2023/11/24')
            .setRequired(true);
        
        const timeInput = new TextInputBuilder()
            .setCustomId('remind_time')
            .setLabel('時刻 (HH:mm)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('例: 15:00')
            .setRequired(true);
        
        const messageInput = new TextInputBuilder()
            .setCustomId('remind_message')
            .setLabel('リマインダーメッセージ')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('例: 会議の時間です')
            .setRequired(true);
        
        const dateRow = new ActionRowBuilder<TextInputBuilder>().addComponents(dateInput);
        const timeRow = new ActionRowBuilder<TextInputBuilder>().addComponents(timeInput);
        const messageRow = new ActionRowBuilder<TextInputBuilder>().addComponents(messageInput);
        
        modal.addComponents(dateRow, timeRow, messageRow);
        
        await interaction.showModal(modal);
        return;
    }

    // Modal送信の処理
    if (interaction.isModalSubmit() && interaction.customId === 'remind_date_time_modal') {
        const dateValue = interaction.fields.getTextInputValue('remind_date');
        const timeValue = interaction.fields.getTextInputValue('remind_time');
        const messageValue = interaction.fields.getTextInputValue('remind_message');
        
        try {
            const [year, month, day] = dateValue.split('/').map(Number);
            const [hour, minute] = timeValue.split(':').map(Number);
            
            if (isNaN(year) || isNaN(month) || isNaN(day) || isNaN(hour) || isNaN(minute)) {
                await interaction.reply({ content: 'エラー: 日時の形式が正しくありません。', ephemeral: true });
                return;
            }
            
            const scheduledAtJST = new Date(year, month - 1, day, hour, minute);
            const scheduledAtUTC = new Date(scheduledAtJST.getTime() - 9 * 60 * 60 * 1000);
            
            const nowJST = new Date();
            if (scheduledAtJST <= nowJST) {
                await interaction.reply({ content: 'エラー: 過去の日時は指定できません。', ephemeral: true });
                return;
            }
            
            // 一時データに保存
            pendingReminders.set(interaction.user.id, {
                scheduledAtJST,
                scheduledAtUTC,
                message: messageValue,
                channelId: interaction.channelId || '',
            });
            
            // User Select Menuを表示
            await showMentionSelectMenuFromInteraction(interaction, scheduledAtJST, messageValue);
            return;
        } catch (error) {
            console.error('Error parsing date:', error);
            await interaction.reply({ content: 'エラー: 日時の形式が正しくありません。`YYYY/MM/DD`と`HH:mm`の形式で入力してください。', ephemeral: true });
            return;
        }
    }

    // User Select Menuの処理
    if (interaction.isUserSelectMenu() && interaction.customId === 'remind_mention_select') {
        await handleReminderMentionSelect(interaction);
        return;
    }

    // 「完了」ボタンの処理
    if (interaction.isButton() && interaction.customId === 'remind_complete_no_mention') {
        await handleReminderComplete(interaction, []);
        return;
    }
});

// メンション選択メニューを表示（メッセージから）
async function showMentionSelectMenu(message: Message, scheduledAtJST: Date, reminderMessage: string) {
    if (!('send' in message.channel) || !message.guild) return;
    
    const selectMenu = new UserSelectMenuBuilder()
        .setCustomId('remind_mention_select')
        .setPlaceholder('メンションするユーザーを選択（任意）')
        .setMinValues(0)
        .setMaxValues(25);

    const completeButton = new ButtonBuilder()
        .setCustomId('remind_complete_no_mention')
        .setLabel('完了（メンションなし）')
        .setStyle(ButtonStyle.Success);

    const selectRow = new ActionRowBuilder<UserSelectMenuBuilder>()
        .addComponents(selectMenu);
    
    const buttonRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(completeButton);

    const jstDateStr = scheduledAtJST.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const reply = await message.channel.send({
        content: `📅 リマインダー情報:\n日時: ${jstDateStr} (JST)\n内容: ${reminderMessage}\n\nメンションするユーザーを選択するか、「完了」ボタンを押してください:`,
        components: [selectRow, buttonRow],
    });

    setTimeout(() => {
        if (pendingReminders.has(message.author.id)) {
            pendingReminders.delete(message.author.id);
            reply.edit({ content: '⏱️ タイムアウト: リマインダーの登録がキャンセルされました。', components: [] }).catch(() => {});
        }
    }, 60000);
}

// メンション選択メニューを表示（Interactionから）
async function showMentionSelectMenuFromInteraction(interaction: any, scheduledAtJST: Date, reminderMessage: string) {
    const selectMenu = new UserSelectMenuBuilder()
        .setCustomId('remind_mention_select')
        .setPlaceholder('メンションするユーザーを選択（任意）')
        .setMinValues(0)
        .setMaxValues(25);

    const completeButton = new ButtonBuilder()
        .setCustomId('remind_complete_no_mention')
        .setLabel('完了（メンションなし）')
        .setStyle(ButtonStyle.Success);

    const selectRow = new ActionRowBuilder<UserSelectMenuBuilder>()
        .addComponents(selectMenu);
    
    const buttonRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(completeButton);

    const jstDateStr = scheduledAtJST.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    await interaction.reply({
        content: `📅 リマインダー情報:\n日時: ${jstDateStr} (JST)\n内容: ${reminderMessage}\n\nメンションするユーザーを選択するか、「完了」ボタンを押してください:`,
        components: [selectRow, buttonRow],
        ephemeral: false,
    });
}

// User Select Menu選択時の処理
async function handleReminderMentionSelect(interaction: UserSelectMenuInteraction) {
    const userId = interaction.user.id;
    const pendingData = pendingReminders.get(userId);

    if (!pendingData) {
        await interaction.reply({ content: 'エラー: リマインダー情報が見つかりません。', ephemeral: true });
        return;
    }

    // 選択されたユーザーIDを取得
    const mentionUserIds = interaction.values;

    // データベースに保存
    const { data, error } = await supabase
        .from('reminders')
        .insert([
            {
                user_id: userId,
                channel_id: pendingData.channelId,
                message: pendingData.message,
                scheduled_at: pendingData.scheduledAtUTC.toISOString(),
                mention_user_ids: mentionUserIds,
            },
        ])
        .select();

    if (error) {
        console.error('Error inserting reminder:', error);
        await interaction.reply({ content: 'エラー: リマインダーの登録に失敗しました。', ephemeral: true });
        return;
    }

    // 一時データを削除
    pendingReminders.delete(userId);

    // メンション文字列を作成
    const mentions = mentionUserIds.length > 0
        ? mentionUserIds.map(id => `<@${id}>`).join(' ')
        : 'なし';

    const jstDateStr = pendingData.scheduledAtJST.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    await interaction.update({
        content: `✅ リマインダーを登録しました！\n日時: ${jstDateStr} (JST)\n内容: ${pendingData.message}\nメンション: ${mentions}`,
        components: [],
    });
}

// 「完了」ボタン押下時の処理
async function handleReminderComplete(interaction: any, mentionUserIds: string[]) {
    const userId = interaction.user.id;
    const pendingData = pendingReminders.get(userId);

    if (!pendingData) {
        await interaction.reply({ content: 'エラー: リマインダー情報が見つかりません。', ephemeral: true });
        return;
    }

    // データベースに保存
    const { data, error } = await supabase
        .from('reminders')
        .insert([
            {
                user_id: userId,
                channel_id: pendingData.channelId,
                message: pendingData.message,
                scheduled_at: pendingData.scheduledAtUTC.toISOString(),
                mention_user_ids: mentionUserIds,
            },
        ])
        .select();

    if (error) {
        console.error('Error inserting reminder:', error);
        await interaction.reply({ content: 'エラー: リマインダーの登録に失敗しました。', ephemeral: true });
        return;
    }

    // 一時データを削除
    pendingReminders.delete(userId);

    const jstDateStr = pendingData.scheduledAtJST.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    await interaction.update({
        content: `✅ リマインダーを登録しました！\n日時: ${jstDateStr} (JST)\n内容: ${pendingData.message}\nメンション: なし`,
        components: [],
    });
}

// ボット作成時のトークンでDiscordと接続
client.login(process.env.TOKEN);

